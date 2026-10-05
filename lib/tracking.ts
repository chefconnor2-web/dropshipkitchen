// Carrier tracking for placed orders. CJ reports only the latest carrier status per tracking number (no scan
// history), so we poll it in the background, keep the newest status on the order (and each parcel of a split
// order), and record every change as a TrackingEvent. Those events become the customer's timeline.
// Stages and carrier links live in lib/carriers.ts.

import { prisma } from "@/lib/db";
import { cjConfigured } from "@/lib/config";
import { trackInfo, type CjTrackInfo } from "@/lib/cj/client";
import { withCjPriority } from "@/lib/cj/lanes";
import { processSingleton } from "@/lib/singleton";
import { refreshCjOrder, SPLIT_METHOD } from "@/lib/fulfillment";
import { sendOrderEmail } from "@/lib/order-emails";
import { ORDER_STATUS } from "@/lib/orders";
import { combinedStage, stageOf, type TrackingStage } from "@/lib/carriers";

// ---------- sync ----------

/** How often an undelivered order's tracking is re-read. */
export function syncIntervalMs(): number {
  const m = Number(process.env.TRACKING_SYNC_MINUTES);
  return (Number.isFinite(m) && m > 0 ? m : 120) * 60_000;
}

/** Orders stop being polled this long after they were placed (lost parcels get handled by hand). */
const MAX_AGE_MS = 90 * 24 * 3600_000;
const BATCH = 40;
const MAX_EVENTS = 60;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);

function eta(i: CjTrackInfo): string | null {
  return str(i.deliveryDay) ?? str(i.deliveryTime);
}

type TrackFields = {
  trackingStage: string | null;
  trackingStatus: string | null;
  trackingEta: string | null;
  lastMileCarrier: string | null;
  lastMileNumber: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
};

/** The new tracking fields for one parcel (or a single-parcel order) given CJ's latest info, or null if nothing changed. */
export function nextTracking(prev: TrackFields, info: CjTrackInfo | undefined, hasNumber: boolean, now = new Date()): TrackFields | null {
  if (!hasNumber) return null;
  const status = info ? str(info.trackingStatus) : null;
  // CJ may not know a fresh number yet: keep what we had, but a number alone means it has shipped.
  const stage: TrackingStage = info ? stageOf(status) : ((prev.trackingStage as TrackingStage | null) ?? "label");
  // A delivered parcel never goes back (a stale read can't un-deliver it).
  if (prev.trackingStage === "delivered" && stage !== "delivered") return null;
  const next: TrackFields = {
    trackingStage: stage,
    trackingStatus: status ?? prev.trackingStatus,
    trackingEta: (info && eta(info)) ?? prev.trackingEta,
    lastMileCarrier: (info && str(info.lastMileCarrier)) ?? prev.lastMileCarrier,
    lastMileNumber: (info && str(info.lastTrackNumber)) ?? prev.lastMileNumber,
    shippedAt: prev.shippedAt ?? now,
    deliveredAt: stage === "delivered" ? (prev.deliveredAt ?? now) : null,
  };
  const same = (Object.keys(next) as (keyof TrackFields)[]).every((k) => String(next[k] ?? "") === String(prev[k] ?? ""));
  return same ? null : next;
}

function pick(o: TrackFields): TrackFields {
  return {
    trackingStage: o.trackingStage,
    trackingStatus: o.trackingStatus,
    trackingEta: o.trackingEta,
    lastMileCarrier: o.lastMileCarrier,
    lastMileNumber: o.lastMileNumber,
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
  };
}

async function recordEvent(orderId: string, parcelIndex: number | null, prev: TrackFields, next: TrackFields) {
  if (prev.trackingStage === next.trackingStage && prev.trackingStatus === next.trackingStatus) return;
  await prisma.trackingEvent.create({
    data: { orderId, parcelIndex, stage: next.trackingStage ?? "label", detail: next.trackingStatus },
  });
  const extra = await prisma.trackingEvent.findMany({ where: { orderId }, orderBy: { at: "desc" }, skip: MAX_EVENTS, select: { id: true } });
  if (extra.length) await prisma.trackingEvent.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
}

/** CJ's latest info for each tracking number, keyed by number. Numbers CJ doesn't know yet aren't in the map. */
type Lookup = Map<string, CjTrackInfo> & { asked?: Set<string> };
async function lookup(numbers: string[]): Promise<Lookup> {
  const out: Lookup = new Map<string, CjTrackInfo>();
  const unique = [...new Set(numbers.filter(Boolean))];
  out.asked = new Set(unique);
  for (let i = 0; i < unique.length; i += 20) {
    const env = await trackInfo(unique.slice(i, i + 20));
    for (const row of env.data ?? []) if (row?.trackingNumber) out.set(String(row.trackingNumber), row);
  }
  return out;
}

/**
 * Re-reads one order from CJ (status, tracking numbers) and the carrier status for its parcels, then records
 * changes and emails the customer when it ships and when it's delivered. Safe to call any time.
 */
export async function syncOrderTracking(orderId: string, known?: Lookup) {
  const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (before.status !== ORDER_STATUS.SUPPLIER_ORDER_PLACED) return before;
  try {
    await refreshCjOrder(orderId);
  } catch (e) {
    // Couldn't re-read the CJ order; the carrier lookup below can still move things along.
    console.warn(`[tracking] refresh ${before.number} failed:`, e instanceof Error ? e.message : e);
  }
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { parcels: { orderBy: { index: "asc" } } } });
  const split = order.cjLogisticName === SPLIT_METHOD;
  const numbers = split ? order.parcels.map((p) => p.cjTrackingNumber ?? "") : [order.cjTrackingNumber ?? ""];
  const missing = numbers.filter((n) => n && !known?.has(n) && !known?.asked?.has(n));
  const info = new Map(known ?? []);
  if (missing.length) for (const [k, v] of await lookup(missing).catch(() => new Map<string, CjTrackInfo>())) info.set(k, v);

  const now = new Date();
  let orderFields: TrackFields = pick(order);
  if (split) {
    const stages: TrackingStage[] = [];
    let shippedAt: Date | null = order.shippedAt;
    for (const p of order.parcels) {
      const prev = pick(p);
      const next = nextTracking(prev, p.cjTrackingNumber ? info.get(p.cjTrackingNumber) : undefined, !!p.cjTrackingNumber, now);
      const cur = next ?? prev;
      if (next) {
        await prisma.orderParcel.update({ where: { id: p.id }, data: next });
        await recordEvent(order.id, p.index, prev, next);
      }
      if (cur.trackingStage) stages.push(cur.trackingStage as TrackingStage);
      if (cur.shippedAt && (!shippedAt || cur.shippedAt < shippedAt)) shippedAt = cur.shippedAt;
    }
    // Every parcel is counted: one not yet shipped keeps the whole order before "delivered".
    const stage = stages.length < order.parcels.length && stages.length ? (combinedStage(stages) === "exception" ? "exception" : "label") : combinedStage(stages);
    const latest = await prisma.orderParcel.findFirst({ where: { orderId, trackingStatus: { not: null } }, orderBy: { index: "asc" } });
    orderFields = {
      ...orderFields,
      trackingStage: stage,
      trackingStatus: latest?.trackingStatus ?? null,
      shippedAt,
      deliveredAt: stage === "delivered" ? (order.deliveredAt ?? now) : null,
    };
  } else {
    const next = nextTracking(orderFields, order.cjTrackingNumber ? info.get(order.cjTrackingNumber) : undefined, !!order.cjTrackingNumber, now);
    if (next) {
      await recordEvent(order.id, null, orderFields, next);
      orderFields = next;
    }
  }
  const updated = await prisma.order.update({ where: { id: orderId }, data: { ...orderFields, trackingCheckedAt: now } });

  if (updated.trackingStage === "delivered" && before.trackingStage !== "delivered") await sendOrderEmail(orderId, "order_delivered");
  if (updated.trackingStage === "exception" && before.trackingStage !== "exception") await sendOrderEmail(orderId, "merchant_tracking_issue");
  return updated;
}

/** Orders whose tracking is due for a re-read (every undelivered one with force). */
export async function dueOrders(now = new Date(), opts: { force?: boolean; limit?: number } = {}) {
  return prisma.order.findMany({
    where: {
      status: ORDER_STATUS.SUPPLIER_ORDER_PLACED,
      deliveredAt: null,
      cjPlacedAt: { gte: new Date(now.getTime() - MAX_AGE_MS) },
      ...(opts.force ? {} : { OR: [{ trackingCheckedAt: null }, { trackingCheckedAt: { lt: new Date(now.getTime() - syncIntervalMs()) } }] }),
    },
    orderBy: [{ trackingCheckedAt: { sort: "asc", nulls: "first" } }],
    take: opts.limit ?? BATCH,
    select: { id: true, cjTrackingNumber: true },
  });
}

const state = processSingleton("tracking-sync", () => ({ running: false, timer: null as NodeJS.Timeout | null, lastRun: null as Date | null }));

/** One pass over every order that's due. Runs in CJ's background lane so shoppers' calls go first. */
export async function syncTracking(opts: { all?: boolean } = {}): Promise<{ checked: number; failed: number; skipped?: boolean }> {
  if (state.running) return { checked: 0, failed: 0, skipped: true };
  if (!cjConfigured()) return { checked: 0, failed: 0 };
  state.running = true;
  try {
    return await withCjPriority("background", async () => {
      const due = await dueOrders(new Date(), { force: opts.all });
      // Known numbers are looked up together up front (one call per 20) instead of one call per order.
      const known = await lookup(due.flatMap((o) => (o.cjTrackingNumber ?? "").split(",").map((n) => n.trim()))).catch(() => undefined);
      let failed = 0;
      for (const o of due) {
        try {
          await syncOrderTracking(o.id, known);
        } catch (e) {
          failed++;
          console.warn(`[tracking] ${o.id} failed:`, e instanceof Error ? e.message : e);
          await prisma.order.update({ where: { id: o.id }, data: { trackingCheckedAt: new Date() } }).catch(() => null);
        }
      }
      if (due.length) console.log(`[tracking] checked ${due.length} order(s), ${failed} failed`);
      return { checked: due.length, failed };
    });
  } finally {
    state.running = false;
    state.lastRun = new Date();
  }
}

/** Starts the background poll once per process (called from instrumentation.ts). TRACKING_SYNC=off disables it. */
export function startTrackingScheduler() {
  if (state.timer || process.env.TRACKING_SYNC === "off") return;
  const every = Math.min(syncIntervalMs(), 30 * 60_000);
  const tick = () => void syncTracking().catch((e) => console.error("[tracking] sync failed:", e));
  // First pass shortly after boot, once the server is warm.
  setTimeout(tick, 90_000).unref?.();
  state.timer = setInterval(tick, every);
  state.timer.unref?.();
}

export function trackingSyncState() {
  return { running: state.running, lastRun: state.lastRun, scheduled: !!state.timer };
}
