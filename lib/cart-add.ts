// Adds one exact variant to a cart, checking stock (cached when known). Shared by the product page and the assistant.
import { prisma } from "@/lib/db";
import { ensureFreshInventory, isStale, stockStatus } from "@/lib/inventory";
import { withCjPriority } from "@/lib/cj/lanes";
import { parsePersonalizeConfig } from "@/lib/personalize-shared";

export async function addVariantToCart(
  cartId: string,
  variantId: string,
  quantity: number,
  personalizationId?: string,
): Promise<{ ok: boolean; message: string }> {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true, offer: true },
  });
  if (!variant || !variant.enabled || variant.product.status !== "PUBLISHED" || !variant.offer)
    return { ok: false, message: "Please choose an available option." };
  // A personalizable item needs the shopper's design first (made in the product page or chat designer).
  if (!personalizationId && parsePersonalizeConfig(variant.product.personalizeJson))
    return { ok: false, message: `${variant.product.title} is made with your own photo or text. Open its designer to personalize it first.` };
  if (personalizationId) {
    const design = await prisma.personalization.findUnique({ where: { id: personalizationId }, select: { variantId: true } });
    if (design?.variantId !== variantId) return { ok: false, message: "That design doesn’t match this option. Please design it again." };
  }

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

  // Each design is its own cart line; plain lines of the same variant merge.
  const existing = personalizationId ? null : await prisma.cartItem.findFirst({ where: { cartId, variantId, personalizationId: null } });
  const newQty = (existing?.quantity ?? 0) + quantity;
  if (fresh?.total !== null && fresh?.total !== undefined && newQty > fresh.total) return { ok: false, message: "Not enough stock for that quantity." };

  if (existing) await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: newQty } });
  else await prisma.cartItem.create({ data: { cartId, productId: variant.productId, variantId, quantity, personalizationId: personalizationId ?? null } });
  return { ok: true, message: `Added ${quantity} × ${variant.product.title} (${variant.name}${personalizationId ? ", personalized" : ""}) to your cart.` };
}
