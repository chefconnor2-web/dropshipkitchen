// Keeps every storefront price on the store rule (lib/money.ts retailCents) as CJ costs change.
import { prisma } from "@/lib/db";
import { retailCents } from "@/lib/money";

/** Reprice storefront variants from their cached CJ cost. Pass product ids to limit it; returns how many changed. */
export async function applyPricingRule(productIds?: string[]): Promise<number> {
  const variants = await prisma.productVariant.findMany({
    where: productIds ? { productId: { in: productIds } } : {},
    select: { id: true, priceCents: true, offer: { select: { cjSupplierVariant: { select: { supplierPriceCents: true } } } } },
  });
  let changed = 0;
  for (const v of variants) {
    const cost = v.offer?.cjSupplierVariant.supplierPriceCents;
    if (cost == null) continue;
    const price = retailCents(cost);
    if (price === v.priceCents) continue;
    await prisma.productVariant.update({ where: { id: v.id }, data: { priceCents: price } });
    changed++;
  }
  return changed;
}

/** Reprice the storefront variants backed by these CJ supplier variants (after a live price refresh). */
export async function applyPricingRuleForSupplierVariants(cjSupplierVariantIds: string[]): Promise<void> {
  const offers = await prisma.supplierOffer.findMany({
    where: { cjSupplierVariantId: { in: cjSupplierVariantIds } },
    select: { productVariant: { select: { productId: true } } },
  });
  const ids = [...new Set(offers.map((o) => o.productVariant.productId))];
  if (ids.length) await applyPricingRule(ids);
}
