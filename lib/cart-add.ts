// Adds one exact variant to a cart, checking stock (cached when known). Shared by the product page and the assistant.
import { prisma } from "@/lib/db";
import { ensureFreshInventory, isStale, stockStatus } from "@/lib/inventory";
import { withCjPriority } from "@/lib/cj/lanes";

export async function addVariantToCart(cartId: string, variantId: string, quantity: number): Promise<{ ok: boolean; message: string }> {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true, offer: true },
  });
  if (!variant || !variant.enabled || variant.product.status !== "PUBLISHED" || !variant.offer)
    return { ok: false, message: "Please choose an available option." };

  // A known cached stock count answers at once (checkout re-checks stale stock live before payment), and
  // a stale one is refreshed in the background. Only a variant we have never counted waits on CJ.
  const svId = variant.offer.cjSupplierVariantId;
  const cached = await prisma.cjSupplierVariant.findUnique({ where: { id: svId }, select: { inventoryTotal: true, inventoryCheckedAt: true } });
  let fresh: { total: number | null } | undefined;
  if (cached && cached.inventoryTotal !== null && cached.inventoryCheckedAt) {
    fresh = { total: cached.inventoryTotal };
    if (isStale(cached.inventoryCheckedAt)) void withCjPriority("background", () => ensureFreshInventory([svId])).catch(() => null);
  } else {
    fresh = (await ensureFreshInventory([svId])).get(svId);
  }
  const status = stockStatus(fresh?.total);
  if (status === "UNKNOWN") return { ok: false, message: "We couldn't confirm availability right now. Please try again shortly." };
  if (status === "UNAVAILABLE") return { ok: false, message: "Sorry, that option is currently unavailable." };

  const existing = await prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
  const newQty = (existing?.quantity ?? 0) + quantity;
  if (fresh?.total !== null && fresh?.total !== undefined && newQty > fresh.total) return { ok: false, message: "Not enough stock for that quantity." };

  await prisma.cartItem.upsert({
    where: { cartId_variantId: { cartId, variantId } },
    update: { quantity: newQty },
    create: { cartId, productId: variant.productId, variantId, quantity },
  });
  return { ok: true, message: `Added ${quantity} × ${variant.product.title} (${variant.name}) to your cart.` };
}
