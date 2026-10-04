// What a shopper sees for shipping on a product: a remembered CJ quote or an estimate at once ("fast"),
// then CJ's live price ("live") when the fast answer wasn't fresh. Customer-safe: tier labels and prices only.
import { prisma } from "@/lib/db";
import { FRESH_MS, daysLabel, estimateFromHistory, peekQuote, quoteCart, type ShipItem } from "@/lib/shipping";

export interface ShipView {
  /** live: a fresh CJ price. stale: an older CJ price, being refreshed. estimate: from earlier quotes. */
  status: "live" | "stale" | "estimate" | "none" | "blocked" | "error";
  tiers: Array<{ key: string; label: string; cents: number; days: string }>;
}

async function shipItem(variantId: string, quantity: number): Promise<ShipItem | null> {
  const v = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true, offer: { include: { cjSupplierVariant: true } } },
  });
  if (!v?.offer || !v.enabled || v.product.status !== "PUBLISHED") return null;
  const sv = v.offer.cjSupplierVariant;
  return { vid: sv.cjVariantId, quantity, inventoryJson: sv.inventoryJson, weightGrams: sv.weightGrams };
}

const view = (status: ShipView["status"], tiers: Array<{ key: string; label: string; cents: number; minDays: number | null; maxDays: number | null }>): ShipView => ({
  status,
  tiers: tiers.map((t) => ({ key: t.key, label: t.label, cents: t.cents, days: daysLabel(t) })),
});

/** Never calls CJ: a remembered quote, else an estimate from similar shipments. */
export async function fastShipView(variantId: string, quantity: number, country: string, zip: string): Promise<ShipView> {
  const item = await shipItem(variantId, quantity);
  if (!item) return { status: "none", tiers: [] };
  const peek = await peekQuote([item], country, zip);
  if (peek) return peek.quote.tiers.length ? view(peek.fresh ? "live" : "stale", peek.quote.tiers) : { status: "blocked", tiers: [] };
  const est = await estimateFromHistory([item], country);
  return est ? view("estimate", [{ key: "standard", label: "Standard", ...est }]) : { status: "none", tiers: [] };
}

/** CJ's fresh price (joins a quote already running for the same item). */
export async function liveShipView(variantId: string, quantity: number, country: string, zip: string): Promise<ShipView> {
  const item = await shipItem(variantId, quantity);
  if (!item) return { status: "none", tiers: [] };
  try {
    const q = await quoteCart([item], country, zip, { maxAgeMs: FRESH_MS });
    return q.tiers.length ? view("live", q.tiers) : { status: "blocked", tiers: [] };
  } catch {
    return { status: "error", tiers: [] };
  }
}
