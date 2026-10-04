// Adds one exact variant to a cart after re-checking its live CJ stock. Shared by the product page and the assistant.
import { prisma } from "@/lib/db";
import { ensureFreshInventory, stockStatus } from "@/lib/inventory";

export async function addVariantToCart(cartId: string, variantId: string, quantity: number): Promise<{ ok: boolean; message: string }> {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true, offer: true },
  });
  if (!variant || !variant.enabled || variant.product.status !== "PUBLISHED" || !variant.offer)
    return { ok: false, message: "Please choose an available option." };

  // Revalidate the exact supplier variant's stock if our cached value is stale.
  const fresh = (await ensureFreshInventory([variant.offer.cjSupplierVariantId])).get(variant.offer.cjSupplierVariantId);
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
