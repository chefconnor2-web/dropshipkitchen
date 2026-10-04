// Turns any CJ product (by PID) into a real, buyable storefront product: imports live price, variants
// and stock, prices it by the store rule and publishes it unlisted (sells by link and assistant, stays
// out of the curated shop grid). A product the merchant hid stays hidden.

import { prisma } from "@/lib/db";
import { cjConfigured } from "@/lib/config";
import { importCjProduct } from "@/lib/cj/import";
import { applyPricingRule } from "@/lib/pricing";
import { blockedListing } from "@/lib/catalog-search";

export const PID_RE = /^[A-Za-z0-9-]{6,64}$/;

// One import per PID at a time: a background warm-up and a shopper's tap on Add share the same work.
const inflight = new Map<string, Promise<Awaited<ReturnType<typeof open>>>>();

/** Returns the published product, or null when it can't be sold (blocked, hidden, no variants, CJ error). */
export function openCjProduct(pid: string) {
  const running = inflight.get(pid);
  if (running) return running;
  const p = open(pid).finally(() => inflight.delete(pid));
  inflight.set(pid, p);
  return p;
}

/** Import products in the background (one at a time, CJ is rate-limited) so Add is instant later. */
export function prewarmProducts(pids: string[]) {
  const unique = [...new Set(pids)].filter((p) => PID_RE.test(p)).slice(0, 12);
  void (async () => {
    for (const pid of unique) {
      const known = await prisma.product.findFirst({ where: { supplierProduct: { cjProductId: pid } }, select: { id: true } }).catch(() => null);
      if (!known) await openCjProduct(pid).catch(() => null);
    }
  })();
}

async function open(pid: string) {
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
