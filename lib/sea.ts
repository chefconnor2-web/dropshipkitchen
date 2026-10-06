// Sea shipping to Canada, end to end without a quote request. CJ's API has no route for items that can't fly
// (big lithium and EV batteries), so the price comes from the merchant's own sea rate card (what their CJ agent
// charges, plus a safety buffer) and the booking goes to the agent by email as soon as the customer pays.
//   cart/checkout  → a "Sea" shipping option priced from the rate card (lib/shipping.ts adds it)
//   payment        → the booking is emailed to the CJ agent automatically (autoBook) or with one click
//   agent replies  → the admin pastes CJ's order id / tracking number once; tracking then runs on its own

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { sendEmail } from "@/lib/email";
import { processSingleton } from "@/lib/singleton";
import { warehousesFrom } from "@/lib/warehouses";

/** The shipping method stored on orders that go by sea. */
export const SEA_METHOD = "SEA";
/** About 4–7 weeks door to door, in business days (Stripe and the cart show this window). */
export const SEA_MIN_DAYS = 20;
export const SEA_MAX_DAYS = 35;

export interface SeaRates {
  enabled: boolean;
  /** Freight per kilogram, China → Canada, dangerous goods included. */
  perKgCents: number;
  /** Least the freight part costs, however light the order. */
  minCents: number;
  /** Fixed per order: customs brokerage, port fees, delivery to the door. */
  perOrderCents: number;
  /** Added on top of everything so a rate change never costs money. */
  bufferPct: number;
  /** Where bookings go (the CJ agent). */
  agentEmail: string;
  /** Email the booking the moment the customer pays (otherwise one click on the order). */
  autoBook: boolean;
}

// Starting rate card, on until the merchant saves their own: consolidated dangerous-goods sea freight China → Canada
// runs about $3–5/kg door to door; $4/kg with a $120 freight minimum, $90 per order for brokerage and delivery and a
// 15% buffer keeps a 30 kg battery near $242. Replace it with the agent's real rate (Admin → Freight).
export const DEFAULT_SEA_RATES: SeaRates = { enabled: true, perKgCents: 400, minCents: 120_00, perOrderCents: 90_00, bufferPct: 15, agentEmail: "", autoBook: true };
const KEY = "sea-rates";

const cache = processSingleton("sea-rates", () => ({ at: 0, rates: DEFAULT_SEA_RATES }));

export async function getSeaRates(): Promise<SeaRates> {
  if (Date.now() - cache.at < 30_000) return cache.rates;
  const row = await prisma.setting.findUnique({ where: { key: KEY } }).catch(() => null);
  let rates = DEFAULT_SEA_RATES;
  try {
    if (row) rates = { ...DEFAULT_SEA_RATES, ...(JSON.parse(row.value) as Partial<SeaRates>) };
  } catch {
    /* unreadable: treat as not set up */
  }
  cache.at = Date.now();
  cache.rates = rates;
  return rates;
}

export async function saveSeaRates(r: SeaRates) {
  if (r.enabled && r.perKgCents <= 0) throw new Error("Enter the per-kg sea rate before switching sea shipping on.");
  if (r.enabled && r.autoBook && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.agentEmail)) throw new Error("Enter your CJ agent’s email so bookings can go out automatically.");
  const value = JSON.stringify(r);
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  cache.at = Date.now();
  cache.rates = r;
}

/** What the customer pays for sea shipping: rate card plus buffer, rounded up to a whole dollar. */
export function seaPriceCents(grams: number, r: Pick<SeaRates, "perKgCents" | "minCents" | "perOrderCents" | "bufferPct">): number {
  const freight = Math.max(r.minCents, r.perKgCents * (grams / 1000));
  const total = (freight + r.perOrderCents) * (1 + Math.max(0, r.bufferPct) / 100);
  return Math.ceil(total / 100) * 100;
}

interface SeaItem {
  quantity: number;
  inventoryJson: string | null;
  weightGrams?: number | null;
}

/** Can the whole order sail from China to this address? Every item must be in (or may be in) the China warehouse and have a weight. */
export function canSail(items: SeaItem[], country: string): boolean {
  if (country !== "CA" || !items.length) return false;
  return items.every((i) => {
    const w = warehousesFrom([i.inventoryJson]);
    return (!w.known || w.cn) && (i.weightGrams ?? 0) > 0;
  });
}

/** The sea option for these items, or null when sea shipping is off or the order can't sail. */
export async function seaTier(items: SeaItem[], country: string) {
  if (!canSail(items, country)) return null;
  const r = await getSeaRates();
  if (!r.enabled || r.perKgCents <= 0) return null;
  const grams = items.reduce((n, i) => n + i.weightGrams! * i.quantity, 0);
  return {
    key: "standard" as const,
    label: "Sea",
    cents: seaPriceCents(grams, r),
    minDays: SEA_MIN_DAYS,
    maxDays: SEA_MAX_DAYS,
    method: SEA_METHOD,
    fromCountry: "CN",
  };
}

// ---------- booking ----------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Emails the sea booking for a paid order to the CJ agent and marks the order placed. In mock or sandbox
 * supplier mode it goes to the store's own inbox instead, marked TEST, so nothing real gets booked.
 */
export async function bookSeaShipment(orderId: string, opts: { auto?: boolean } = {}) {
  const { supplierMode } = await import("@/lib/fulfillment");
  const { ORDER_STATUS } = await import("@/lib/orders");
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  if (order.customerShipMethod !== SEA_METHOD) throw new Error("This order didn’t choose sea shipping.");
  const rates = await getSeaRates();
  const live = supplierMode() === "live";
  const to = live ? rates.agentEmail : config.email.storeEmail || rates.agentEmail;
  if (!to) throw new Error(live ? "Set your CJ agent’s email under Freight → Sea shipping first." : "Set STORE_EMAIL to receive test sea bookings.");

  const locked = await prisma.order.updateMany({
    where: { id: order.id, status: ORDER_STATUS.AWAITING_MERCHANT_APPROVAL, cjPlacedAt: null },
    data: { status: ORDER_STATUS.PLACING_SUPPLIER_ORDER, cjError: null },
  });
  if (locked.count === 0) throw new Error("This order is no longer awaiting approval, or it was already booked.");

  const ship = order.shippingAddressJson ? (JSON.parse(order.shippingAddressJson) as { name?: string; phone?: string; address?: Record<string, string | null> }) : null;
  const a = ship?.address ?? {};
  const address = [ship?.name || order.customerName, a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(" "), a.country, order.customerPhone || ship?.phone]
    .filter(Boolean)
    .join("\n");
  const lines = order.items
    .map((i) => `${i.quantity} × ${i.productTitle}${i.variantName && !/^default$/i.test(i.variantName) ? ` (${i.variantName})` : ""} · CJ SKU ${i.supplierSku} · VID ${i.supplierVariantId} · PID ${i.supplierProductId}`)
    .join("\n");
  const test = live ? "" : "[TEST — not sent to your agent] ";
  const subject = `${test}Sea shipment booking · order ${order.number} · China → Canada`;
  const text = `Hello,

Please book this order by SEA from your China warehouse to Canada. It contains lithium batteries (UN3480/UN3481), so it can't fly: please ship it as dangerous-goods sea freight, delivered to the door.

Our order number: ${order.number}

Items:
${lines}

Deliver to:
${address}

Please create the CJ order under our account with our order number as the reference, and reply with the CJ order id (or tracking number) and the total cost.

Thank you,
${config.storeName}`;
  const res = await sendEmail({
    to,
    kind: "sea_booking",
    orderId: order.id,
    subject,
    text,
    html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${esc(text)}</pre>`,
  });
  if (res.status !== "sent") {
    const message = `The sea booking email didn’t go out (${res.error ?? res.status}). Fix email, then book again.`;
    await prisma.order.update({ where: { id: order.id }, data: { status: ORDER_STATUS.AWAITING_MERCHANT_APPROVAL, cjError: message } });
    throw new Error(message);
  }
  return prisma.order.update({
    where: { id: order.id },
    data: {
      status: ORDER_STATUS.SUPPLIER_ORDER_PLACED,
      decidedAt: new Date(),
      cjSandbox: !live,
      cjLogisticName: SEA_METHOD,
      cjFromCountry: "CN",
      cjOrderNumber: order.number,
      cjPlacedAt: new Date(),
      cjError: null,
      decisionNote: live
        ? `Sea booking ${opts.auto ? "sent automatically" : "sent"} to ${to}. Paste CJ’s order id or tracking number below when they reply.`
        : `TEST sea booking sent to ${to} (SUPPLIER_MODE is ${supplierMode()}, so your agent didn’t get it).`,
    },
  });
}

/** Right after payment: book sea orders on their own when the merchant has switched that on. Never throws. */
export async function autoBookSea(orderId: string) {
  try {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { customerShipMethod: true } });
    if (o?.customerShipMethod !== SEA_METHOD) return;
    const r = await getSeaRates();
    if (!r.autoBook) return;
    await bookSeaShipment(orderId, { auto: true });
  } catch (e) {
    console.warn(`[sea] auto-booking ${orderId} failed:`, e instanceof Error ? e.message : e);
  }
}

/** The agent's reply: CJ's order id and/or tracking number, and what it actually cost. Tracking takes over from here. */
export async function linkSeaShipment(orderId: string, input: { cjOrderId?: string; trackingNumber?: string; costCents?: number | null }) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.cjLogisticName !== SEA_METHOD) throw new Error("This isn’t a sea order.");
  const cjOrderId = input.cjOrderId?.trim() || null;
  const tracking = input.trackingNumber?.trim() || null;
  if (!cjOrderId && !tracking && input.costCents == null) throw new Error("Enter CJ’s order id, a tracking number or the cost.");
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      ...(cjOrderId ? { cjOrderId } : {}),
      ...(tracking ? { cjTrackingNumber: tracking } : {}),
      ...(input.costCents != null ? { cjAmountCents: input.costCents, cjPaidAt: order.cjPaidAt ?? new Date() } : {}),
    },
  });
  if (tracking && !order.cjTrackingNumber) {
    const { sendOrderEmail } = await import("@/lib/order-emails");
    await sendOrderEmail(orderId, "order_shipped");
  }
  return updated;
}

