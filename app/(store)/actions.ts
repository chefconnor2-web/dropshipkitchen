"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { config, stripeKeyProblem } from "@/lib/config";
import { getOrCreateCartId, getCartId, loadCart } from "@/lib/cart";
import { ensureFreshInventory, stockStatus } from "@/lib/inventory";
import { stripe } from "@/lib/stripe";
import { newOrderNumber, ORDER_STATUS } from "@/lib/orders";
import { linkProductById, platformById, platformName } from "@/lib/lineup";

export type CartActionState = { ok: boolean; message: string } | null;

export async function addToCart(_prev: CartActionState, form: FormData): Promise<CartActionState> {
  const variantId = String(form.get("variantId") || "");
  const quantity = Math.max(1, Math.min(99, Number(form.get("quantity")) || 1));
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

  const cartId = await getOrCreateCartId();
  const existing = await prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
  const newQty = (existing?.quantity ?? 0) + quantity;
  if (fresh?.total !== null && fresh?.total !== undefined && newQty > fresh.total)
    return { ok: false, message: "Not enough stock for that quantity." };

  await prisma.cartItem.upsert({
    where: { cartId_variantId: { cartId, variantId } },
    update: { quantity: newQty },
    create: { cartId, productId: variant.productId, variantId, quantity },
  });
  revalidatePath("/", "layout");
  return { ok: true, message: `Added ${quantity} × ${variant.product.title} (${variant.name}) to your cart.` };
}

export async function updateCartItem(form: FormData) {
  const cartId = await getCartId();
  const itemId = String(form.get("itemId") || "");
  const quantity = Number(form.get("quantity"));
  if (!cartId) return;
  if (!quantity || quantity < 1) await prisma.cartItem.deleteMany({ where: { id: itemId, cartId } });
  else await prisma.cartItem.updateMany({ where: { id: itemId, cartId }, data: { quantity: Math.min(99, quantity) } });
  revalidatePath("/", "layout");
}

export async function checkout() {
  const problem = stripeKeyProblem();
  if (problem) redirect(`/cart?error=${encodeURIComponent("Checkout is not configured: " + problem)}`);

  const cart = await loadCart(await getCartId());
  const items = cart?.items.filter((i) => i.variant.enabled && i.variant.product.status === "PUBLISHED" && i.variant.offer) ?? [];
  if (!cart || items.length === 0) redirect("/cart");

  // Re-validate stale stock for every exact CJ VID before taking payment.
  const fresh = await ensureFreshInventory(items.map((i) => i.variant.offer!.cjSupplierVariantId));
  for (const i of items) {
    const f = fresh.get(i.variant.offer!.cjSupplierVariantId);
    const s = stockStatus(f?.total);
    if (s === "UNKNOWN" || s === "UNAVAILABLE" || (f?.total != null && i.quantity > f.total)) {
      redirect(`/cart?error=${encodeURIComponent(`${i.variant.product.title} (${i.variant.name}) is no longer available in that quantity.`)}`);
    }
  }
  const svs = await prisma.cjSupplierVariant.findMany({
    where: { id: { in: items.map((i) => i.variant.offer!.cjSupplierVariantId) } },
  });
  const svById = new Map(svs.map((s) => [s.id, s]));

  // Order + immutable supplier snapshot, created before payment so the mapping is fixed now.
  const order = await prisma.order.create({
    data: {
      number: newOrderNumber(),
      status: ORDER_STATUS.PENDING_PAYMENT,
      subtotalCents: items.reduce((s, i) => s + i.variant.priceCents * i.quantity, 0),
      items: {
        create: items.map((i) => {
          const offer = i.variant.offer!;
          const sv = svById.get(offer.cjSupplierVariantId);
          return {
            productId: i.variant.productId,
            productVariantId: i.variant.id,
            productTitle: i.variant.product.title,
            variantName: i.variant.name,
            internalSku: i.variant.internalSku,
            quantity: i.quantity,
            customerPriceCents: i.variant.priceCents,
            supplier: offer.supplier,
            supplierProductId: offer.supplierProductId,
            supplierProductSku: offer.supplierProductSku,
            supplierVariantId: offer.supplierVariantId,
            supplierSku: offer.supplierSku,
            supplierPriceAtOrderCents: sv?.supplierPriceCents ?? null,
            supplierInventoryAtOrder: sv?.inventoryTotal ?? null,
            supplierInventoryCheckedAt: sv?.inventoryCheckedAt ?? null,
          };
        }),
      },
    },
  });

  // Stripe only ever sees OUR product names and prices.
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: items.map((i) => ({
      quantity: i.quantity,
      price_data: {
        currency: "usd",
        unit_amount: i.variant.priceCents,
        product_data: { name: `${i.variant.product.title} — ${i.variant.name}` },
      },
    })),
    shipping_address_collection: { allowed_countries: ["US", "CA", "GB", "AU", "NZ", "IE"] },
    // Carriers ask for a phone number; it goes to CJ with the shipping address.
    phone_number_collection: { enabled: true },
    metadata: { orderId: order.id, orderNumber: order.number },
    success_url: `${config.siteUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.siteUrl}/cart`,
  });
  await prisma.order.update({ where: { id: order.id }, data: { stripeSessionId: session.id } });
  redirect(session.url!);
}

export type WaitlistState = { ok: boolean; message: string } | null;

/** "Tell me when it launches" for a Link line product on one battery platform. */
export async function joinWaitlist(_prev: WaitlistState, form: FormData): Promise<WaitlistState> {
  const email = String(form.get("email") || "").trim().toLowerCase();
  const platform = platformById(String(form.get("platform") || ""));
  const product = linkProductById(String(form.get("productId") || ""));
  if (!product) return { ok: false, message: "Please pick a product." };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: "Please enter a valid email." };
  await prisma.waitlistEntry.upsert({
    where: { email_platform_productId: { email, platform: platform.id, productId: product.id } },
    update: {},
    create: { email, platform: platform.id, productId: product.id },
  });
  const name = `${platformName(platform)} ${product.name}`;
  if (!product.fits.includes(platform.id))
    return { ok: true, message: `Noted. Every ask counts toward what we build next. We’ll email you if the ${name} goes into testing.` };
  return { ok: true, message: `You’re on the list. We’ll email you once the ${name} passes testing.` };
}
