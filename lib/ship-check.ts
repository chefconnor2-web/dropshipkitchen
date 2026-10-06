// "Ships to Canada" badges on product cards. The answer follows the store's warehouse rule (lib/warehouses.ts):
// China-warehouse stock ships to the US and Canada; US-warehouse stock ships to US addresses only. So a badge only
// needs to know which warehouse holds the product, never a freight quote (the cart still quotes live before
// checkout). Unknown products answer at once with CJ's default, China ("Ships to Canada"), while a background
// stock lookup confirms the warehouse; the card quietly updates if it turns out to be US-only.
import { prisma } from "@/lib/db";
import { getStockByVid, getVariantsByPid } from "@/lib/cj/client";
import { withCjPriority } from "@/lib/cj/lanes";
import { processSingleton } from "@/lib/singleton";
import { PID_RE } from "@/lib/open-product";
import { canShipFrom, originsCode, parseOrigins, warehousesFrom } from "@/lib/warehouses";

/**
 * from: where the product ships from ("US", "CN", "US,CN"), when known. provisional: answered by the default
 * (China) while the warehouse is being confirmed; ask again later.
 */
export type ShipStatus =
  | { state: "ok"; cents: number | null; from?: string | null; provisional?: boolean }
  | { state: "no"; from?: string | null }
  | { state: "pending" };

const TTL_MS = 7 * 86_400_000;
/** Products checked per request (the rest are asked for again as the shopper scrolls or polls). */
const MAX_PER_REQUEST = 30;
const inflight = processSingleton("ship-check-inflight", () => new Map<string, Promise<void>>());

/** Can a product held in these warehouses reach this country? Unknown warehouse: China, CJ's default. */
export function shipsByRule(origins: string | null | undefined, country: string): boolean {
  const w = parseOrigins(origins && origins !== "?" ? origins : null);
  if (!w.known) return true;
  return (w.cn && canShipFrom("CN", country)) || (w.us && canShipFrom("US", country)) || (!w.us && !w.cn);
}

/** Answers for these products in this country, always right away. Unknown or stale ones are confirmed in the background. */
export async function shipStatuses(pids: string[], country: string): Promise<Record<string, ShipStatus>> {
  const wanted = [...new Set(pids.filter((p) => PID_RE.test(p)))].slice(0, MAX_PER_REQUEST);
  // Where a product ships from doesn't depend on the shopper's country, so any country's answer tells us.
  const rows = await prisma.shipCheck.findMany({ where: { pid: { in: wanted }, origins: { not: null } }, orderBy: { checkedAt: "desc" } });
  const known = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!known.has(r.pid) || r.country === country) known.set(r.pid, r);
  // Products already in our catalog with counted stock answer straight from the database.
  const missing = wanted.filter((p) => !known.has(p));
  const local = missing.length
    ? await prisma.cjSupplierVariant.findMany({
        where: { supplierProduct: { cjProductId: { in: missing } }, inventoryJson: { not: null } },
        select: { inventoryJson: true, supplierProduct: { select: { cjProductId: true } } },
      })
    : [];
  const localOrigins = new Map<string, string | null>();
  for (const pid of missing) {
    const w = warehousesFrom(local.filter((v) => v.supplierProduct.cjProductId === pid).map((v) => v.inventoryJson));
    if (w.known) localOrigins.set(pid, originsCode(w));
  }

  const out: Record<string, ShipStatus> = {};
  for (const pid of wanted) {
    const r = known.get(pid);
    const origins = r ? r.origins : localOrigins.get(pid);
    const from = origins && origins !== "?" ? origins : null;
    if (origins === undefined) {
      // Never seen: answer by the default now, confirm the warehouse in the background.
      out[pid] = { state: "ok", cents: null, from: null, provisional: true };
      startCheck(pid);
      continue;
    }
    // A stored "no" for this very country (an old live quote with no route) still counts.
    const ok = r && r.country === country && !r.ok ? false : shipsByRule(origins, country);
    out[pid] = ok ? { state: "ok", cents: null, from } : { state: "no", from };
    if (r && Date.now() - r.checkedAt.getTime() > TTL_MS) startCheck(pid);
  }
  return out;
}

function startCheck(pid: string) {
  if (inflight.has(pid)) return;
  const job = withCjPriority("background", () => check(pid))
    .catch(() => null)
    .finally(() => inflight.delete(pid));
  inflight.set(pid, job.then(() => undefined));
}

/** Which warehouses hold the product's first option: one or two CJ calls, no freight quote. */
async function check(pid: string) {
  const item = await firstItem(pid);
  if (!item) return; // couldn't tell (CJ error): the default answer stands, try again next time
  const origins = originsCode(warehousesFrom([item.inventoryJson])) ?? "?";
  // Stored under a neutral country key; the rule turns it into an answer for any shopper.
  const data = { ok: true, cents: null, origins, checkedAt: new Date() };
  await prisma.shipCheck.upsert({ where: { pid_country: { pid, country: "*" } }, create: { pid, country: "*", ...data }, update: data });
}

/** The product's first sellable option: from our catalog when imported, else straight from CJ (one call). */
async function firstItem(pid: string): Promise<{ vid: string; inventoryJson: string | null; weightGrams: number | null } | null> {
  const sv = await prisma.cjSupplierVariant.findFirst({
    where: { supplierProduct: { cjProductId: pid }, offers: { some: {} } },
    orderBy: { id: "asc" },
    select: { cjVariantId: true, inventoryJson: true, weightGrams: true },
  });
  if (sv) return { vid: sv.cjVariantId, inventoryJson: sv.inventoryJson ?? (await stockRows(sv.cjVariantId)), weightGrams: sv.weightGrams };
  const variants = (await getVariantsByPid(pid)).data ?? [];
  const v = variants[0];
  if (!v?.vid) return null;
  const grams = Number(v.variantWeight);
  return { vid: v.vid, inventoryJson: await stockRows(v.vid), weightGrams: Number.isFinite(grams) && grams > 0 ? grams : null };
}

/** Which warehouses stock this option (one CJ call), as stock rows; null when CJ can't say right now. */
async function stockRows(vid: string): Promise<string | null> {
  try {
    return JSON.stringify((await getStockByVid(vid)).data ?? []);
  } catch {
    return null;
  }
}
