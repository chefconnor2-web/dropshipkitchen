// Turns any CJ product (by PID) into a real, buyable storefront product: imports live price, variants
// and stock, prices it by the store rule and publishes it unlisted (sells by link and assistant, stays
// out of the curated shop grid). A product the merchant hid stays hidden.

import { prisma } from "@/lib/db";
import { cjConfigured } from "@/lib/config";
import { importCjProduct } from "@/lib/cj/import";
import { applyPricingRule } from "@/lib/pricing";
import { blockedListing } from "@/lib/catalog-search";

export const PID_RE = /^[A-Za-z0-9-]{6,64}$/;

/** Returns the published product, or null when it can't be sold (blocked, hidden, no variants, CJ error). */
export async function openCjProduct(pid: string) {
  if (!PID_RE.test(pid) || !cjConfigured()) return null;
  const known = await prisma.product.findFirst({ where: { supplierProduct: { cjProductId: pid } } });
  if (known) return known.status === "PUBLISHED" ? known : null;

  let productId: string;
  try {
    // Check stock for a few options now; the rest are re-checked live at add-to-cart and checkout.
    productId = (await importCjProduct(pid, { maxStockChecks: 3 })).productId;
  } catch {
    return null;
  }
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: { supplierProduct: true, variants: { where: { enabled: true }, include: { offer: true } } },
  });
  if (blockedListing(product.supplierProduct?.cjProductName ?? product.title) || !product.variants.some((v) => v.offer)) {
    await prisma.product.delete({ where: { id: product.id } });
    return null;
  }
  await applyPricingRule([product.id]);
  return prisma.product.update({ where: { id: product.id }, data: { status: "PUBLISHED", listed: false } });
}
