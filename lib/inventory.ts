import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { getStockByVid, getVariantByVid } from "@/lib/cj/client";
import { normalizeVariant, sumInventory } from "@/lib/cj/normalize";
import { applyPricingRuleForSupplierVariants } from "@/lib/pricing";

export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "UNAVAILABLE" | "UNKNOWN";

export function stockStatus(total: number | null | undefined): StockStatus {
  if (total === null || total === undefined) return "UNKNOWN";
  if (total <= 0) return "UNAVAILABLE";
  if (total < config.inventory.lowStockThreshold) return "LOW_STOCK";
  return "IN_STOCK";
}

/** Customer-facing label — never exposes the supplier's unit count. */
export function stockLabel(s: StockStatus): string {
  return { IN_STOCK: "In Stock", LOW_STOCK: "Low Stock", UNAVAILABLE: "Unavailable", UNKNOWN: "Checking availability" }[s];
}

export function isStale(checkedAt: Date | null | undefined): boolean {
  if (!checkedAt) return true;
  return Date.now() - checkedAt.getTime() > config.inventory.ttlMinutes * 60_000;
}

/** Query CJ stock for one exact VID and cache it on the supplier variant. */
export async function refreshInventory(cjSupplierVariantId: string) {
  const sv = await prisma.cjSupplierVariant.findUniqueOrThrow({ where: { id: cjSupplierVariantId } });
  const env = await getStockByVid(sv.cjVariantId);
  const total = sumInventory(env.data);
  return prisma.cjSupplierVariant.update({
    where: { id: sv.id },
    data: { inventoryTotal: total, inventoryJson: JSON.stringify(env.data ?? []), inventoryCheckedAt: new Date() },
  });
}

/** Query CJ for the current price of one exact VID and cache it. */
export async function refreshPrice(cjSupplierVariantId: string) {
  const sv = await prisma.cjSupplierVariant.findUniqueOrThrow({ where: { id: cjSupplierVariantId } });
  const env = await getVariantByVid(sv.cjVariantId);
  const n = normalizeVariant({ ...env.data, vid: env.data?.vid ?? sv.cjVariantId });
  const updated = await prisma.cjSupplierVariant.update({
    where: { id: sv.id },
    data: {
      supplierPriceCents: n.supplierPriceCents ?? sv.supplierPriceCents,
      priceCheckedAt: new Date(),
      rawJson: JSON.stringify(env.data),
    },
  });
  // Storefront prices follow CJ's cost under the store rule.
  await applyPricingRuleForSupplierVariants([sv.id]);
  return updated;
}

/** Full live recheck (price + stock) of one exact VID. */
export async function refreshLive(cjSupplierVariantId: string) {
  await refreshPrice(cjSupplierVariantId);
  return refreshInventory(cjSupplierVariantId);
}

/**
 * Re-query CJ for any of the given supplier variants whose cached stock is stale.
 * Returns per-variant results; a failed CJ call leaves the cache as-is and reports the error.
 */
export async function ensureFreshInventory(cjSupplierVariantIds: string[]) {
  const rows = await prisma.cjSupplierVariant.findMany({ where: { id: { in: cjSupplierVariantIds } } });
  const out = new Map<string, { total: number | null; checkedAt: Date | null; error?: string }>();
  for (const r of rows) {
    if (!isStale(r.inventoryCheckedAt)) {
      out.set(r.id, { total: r.inventoryTotal, checkedAt: r.inventoryCheckedAt });
      continue;
    }
    try {
      const u = await refreshInventory(r.id);
      out.set(r.id, { total: u.inventoryTotal, checkedAt: u.inventoryCheckedAt });
    } catch (e) {
      out.set(r.id, {
        total: r.inventoryTotal,
        checkedAt: r.inventoryCheckedAt,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}
