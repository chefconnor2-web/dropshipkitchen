import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { cjConfigured } from "@/lib/config";
import { importCjProduct } from "@/lib/cj/import";
import { applyPricingRule } from "@/lib/pricing";
import { blockedListing } from "@/lib/catalog-search";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/**
 * Opens a search result as a real, buyable product page: imports the CJ product (live price, variants
 * and stock), prices it by the store rule and publishes it unlisted, so it sells by link but stays out
 * of the curated shop grid. A product the merchant already has keeps the merchant's own status.
 */
export default async function OpenSearchResult({ params }: { params: Promise<{ pid: string }> }) {
  const pid = decodeURIComponent((await params).pid);
  if (!/^[A-Za-z0-9-]{6,64}$/.test(pid) || !cjConfigured()) notFound();

  const known = await prisma.product.findFirst({ where: { supplierProduct: { cjProductId: pid } } });
  if (known) {
    if (known.status === "PUBLISHED") redirect(`/products/${known.slug}`);
    notFound(); // the merchant hid it on purpose
  }

  let productId: string;
  try {
    productId = (await importCjProduct(pid)).productId;
  } catch {
    notFound();
  }
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: { supplierProduct: true, variants: { where: { enabled: true }, include: { offer: true } } },
  });
  if (blockedListing(product.supplierProduct?.cjProductName ?? product.title) || !product.variants.some((v) => v.offer)) {
    await prisma.product.delete({ where: { id: product.id } });
    notFound();
  }
  await applyPricingRule([product.id]);
  const live = await prisma.product.update({
    where: { id: product.id },
    data: { status: "PUBLISHED", listed: false, categories: product.categories || "" },
  });
  redirect(`/products/${live.slug}`);
}
