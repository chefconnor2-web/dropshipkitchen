"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { config, stripeKeyProblem } from "@/lib/config";
import { cartBoxPicks, cartShipItems, getOrCreateCartId, getCartId, getShipTo, loadCart, setShipTo } from "@/lib/cart";
import { allocatePrice, drawBox, loadPool, type PoolVariant } from "@/lib/mystery";
import { addVariantToCart } from "@/lib/cart-add";
import { priceOrder } from "@/lib/volume";
import { createFreightRequest } from "@/lib/freight";
import { daysLabel, isShipCountry, parcelsLabel, quoteTiers } from "@/lib/shipping";
import { ensureFreshInventory, stockStatus } from "@/lib/inventory";
import { stripe } from "@/lib/stripe";
import { newOrderNumber, ORDER_STATUS } from "@/lib/orders";
import { linkProductById, platformById, platformName } from "@/lib/lineup";

export type CartActionState = { ok: boolean; message: string } | null;

export async function addToCart(_prev: CartActionState, form: FormData): Promise<CartActionState> {
  const variantId = String(form.get("variantId") || "");
  const quantity = Math.max(1, Math.min(99, Number(form.get("quantity")) || 1));
  const r = await addVariantToCart(await getOrCreateCartId(), variantId, quantity);
  revalidatePath("/", "layout");
  return r;
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
  if (!cart || (items.length === 0 && cart.boxes.length === 0)) redirect("/cart");

  // Mystery boxes: confirm each drawn item is still sellable and in stock; redraw a box whose draw went stale.
  const boxes: Array<{ cartBoxId: string; name: string; priceCents: number; picks: PoolVariant[] }> = [];
  for (const cb of cart.boxes) {
    if (cb.box.status !== "PUBLISHED") redirect(`/cart?error=${encodeURIComponent(`${cb.box.name} isn’t available any more. Remove it to continue.`)}`);
    const pool = await loadPool(cb.boxId);
    const wanted = JSON.parse(cb.picksJson) as string[];
    const svIds = (await prisma.supplierOffer.findMany({ where: { productVariantId: { in: wanted } }, select: { cjSupplierVariantId: true } })).map((o) => o.cjSupplierVariantId);
    await ensureFreshInventory(svIds);
    const fresh = await loadPool(cb.boxId);
    let picks: PoolVariant[] | null = wanted.map((id) => fresh.find((v) => v.variantId === id)).filter((v): v is PoolVariant => !!v && v.inStock);
    if (picks.length !== wanted.length) {
      picks = drawBox(fresh.length ? fresh : pool, cb.box);
      if (!picks) redirect(`/cart?error=${encodeURIComponent(`${cb.box.name} is sold out right now. Remove it to continue.`)}`);
      await prisma.cartBox.update({ where: { id: cb.id }, data: { picksJson: JSON.stringify(picks.map((v) => v.variantId)) } });
    }
    boxes.push({ cartBoxId: cb.id, name: cb.box.name, priceCents: cb.box.priceCents, picks });
  }
  const boxVariants = boxes.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: boxes.flatMap((b) => b.picks.map((p) => p.variantId)) } },
        include: { product: true, offer: { include: { cjSupplierVariant: true } } },
      })
    : [];
  const boxVariantById = new Map(boxVariants.map((v) => [v.id, v]));

  // Re-validate stale stock for every exact CJ VID before taking payment.
  const fresh = await ensureFreshInventory(items.map((i) => i.variant.offer!.cjSupplierVariantId));
  for (const i of items) {
    const f = fresh.get(i.variant.offer!.cjSupplierVariantId);
    const s = stockStatus(f?.total);
    if (s === "UNKNOWN" || s === "UNAVAILABLE" || (f?.total != null && i.quantity > f.total)) {
      redirect(`/cart?error=${encodeURIComponent(`${i.variant.product.title} (${i.variant.name}) is no longer available in that quantity.`)}`);
    }
  }
  // Bulk pricing for the whole transaction, from the cached supplier cost (the same numbers the cart showed).
  const svCost = new Map(
    (await prisma.cjSupplierVariant.findMany({ where: { id: { in: items.map((i) => i.variant.offer!.cjSupplierVariantId) } }, select: { id: true, supplierPriceCents: true } })).map((v) => [v.id, v.supplierPriceCents]),
  );
  const priced = priceOrder(items.map((i) => ({ listCents: i.variant.priceCents, costCents: svCost.get(i.variant.offer!.cjSupplierVariantId), quantity: i.quantity })));
  const unitPrice = (i: (typeof items)[number]) => priced.unitCents[items.indexOf(i)];

  // Shipping is CJ's live quote for these exact VIDs to the shopper's country, charged at cost.
  const shipTo = await getShipTo();
  if (!isShipCountry(shipTo.country)) redirect(`/cart?error=${encodeURIComponent("Choose where we’re shipping to.")}`);
  let tiers;
  try {
    tiers = await quoteTiers(cartShipItems(cart, await cartBoxPicks(cart)), shipTo.country, shipTo.zip);
  } catch {
    redirect(`/cart?error=${encodeURIComponent("We couldn’t get a shipping price right now. Please try again in a minute.")}`);
  }
  const tier = tiers.find((t) => t.key === shipTo.tier) ?? tiers[0];
  if (!tier) redirect(`/cart?error=${encodeURIComponent("Sorry, we can’t ship these items to that country.")}`);

  const svs = await prisma.cjSupplierVariant.findMany({
    where: { id: { in: items.map((i) => i.variant.offer!.cjSupplierVariantId) } },
  });
  const svById = new Map(svs.map((s) => [s.id, s]));

  // Order + immutable supplier snapshot, created before payment so the mapping is fixed now.
  const order = await prisma.order.create({
    data: {
      number: newOrderNumber(),
      status: ORDER_STATUS.PENDING_PAYMENT,
      subtotalCents: items.reduce((s, i) => s + unitPrice(i) * i.quantity, 0) + boxes.reduce((n, b) => n + b.priceCents, 0),
      shippingCents: tier.cents,
      customerShipMethod: tier.method,
      customerShipCountry: shipTo.country,
      parcelPlanJson: tier.parcels ? JSON.stringify(tier.parcels) : null,
      items: {
        create: [
          // Mystery box contents: the box price is spread over its items so totals and margins stay exact.
          ...boxes.flatMap((b) => {
            const prices = allocatePrice(b.priceCents, b.picks);
            return b.picks.map((p, n) => {
              const v = boxVariantById.get(p.variantId)!;
              const offer = v.offer!;
              return {
                productId: v.productId,
                productVariantId: v.id,
                productTitle: v.product.title,
                variantName: v.name,
                internalSku: v.internalSku,
                quantity: 1,
                customerPriceCents: prices[n],
                supplier: offer.supplier,
                supplierProductId: offer.supplierProductId,
                supplierProductSku: offer.supplierProductSku,
                supplierVariantId: offer.supplierVariantId,
                supplierSku: offer.supplierSku,
                supplierPriceAtOrderCents: offer.cjSupplierVariant.supplierPriceCents,
                supplierInventoryAtOrder: offer.cjSupplierVariant.inventoryTotal,
                supplierInventoryCheckedAt: offer.cjSupplierVariant.inventoryCheckedAt,
                mysteryBoxName: b.name,
                mysteryBoxGroup: b.cartBoxId,
              };
            });
          }),
          ...items.map((i) => {
          const offer = i.variant.offer!;
          const sv = svById.get(offer.cjSupplierVariantId);
          return {
            productId: i.variant.productId,
            productVariantId: i.variant.id,
            productTitle: i.variant.product.title,
            variantName: i.variant.name,
            internalSku: i.variant.internalSku,
            quantity: i.quantity,
            customerPriceCents: unitPrice(i),
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
        ],
      },
    },
  });

  // Stripe only ever sees OUR product names and prices.
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      ...items.map((i) => ({
        quantity: i.quantity,
        price_data: {
          currency: "usd",
          unit_amount: unitPrice(i),
          product_data: { name: `${i.variant.product.title} — ${i.variant.name}` },
        },
      })),
      // A box shows as one line: its contents stay a surprise until after payment.
      ...boxes.map((b) => ({
        quantity: 1,
        price_data: { currency: "usd", unit_amount: b.priceCents, product_data: { name: `Mystery box: ${b.name}` } },
      })),
    ],
    // The address must be in the country the shipping price was quoted for.
    shipping_address_collection: { allowed_countries: [shipTo.country as "US"] },
    shipping_options: [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: tier.cents, currency: "usd" },
          display_name: `${tier.label} shipping (${[parcelsLabel(tier), daysLabel(tier)].filter(Boolean).join(", ")})`,
          ...(tier.minDays != null && tier.maxDays != null
            ? {
                delivery_estimate: {
                  minimum: { unit: "business_day" as const, value: tier.minDays },
                  maximum: { unit: "business_day" as const, value: tier.maxDays },
                },
              }
            : {}),
        },
      },
    ],
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

export interface PublicShipTier {
  key: "standard" | "express";
  label: string;
  cents: number;
  days: string;
}
export type ShipEstimateState = { ok: true; country: string; tiers: PublicShipTier[] } | { ok: false; message: string } | null;

/** Product page: live shipping for one variant to a country (and ZIP). Remembers the destination for the cart. */
export async function estimateShipping(_prev: ShipEstimateState, form: FormData): Promise<ShipEstimateState> {
  const variantId = String(form.get("variantId") || "");
  const country = String(form.get("country") || "");
  const zip = String(form.get("zip") || "").trim().slice(0, 12);
  const quantity = Math.max(1, Math.min(99, Number(form.get("quantity")) || 1));
  if (!isShipCountry(country)) return { ok: false, message: "Choose a country we ship to." };
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true, offer: { include: { cjSupplierVariant: true } } },
  });
  if (!variant?.offer || !variant.enabled || variant.product.status !== "PUBLISHED") return { ok: false, message: "Choose an option first." };
  try {
    const tiers = await quoteTiers(
      [{ vid: variant.offer.cjSupplierVariant.cjVariantId, quantity, inventoryJson: variant.offer.cjSupplierVariant.inventoryJson, weightGrams: variant.offer.cjSupplierVariant.weightGrams }],
      country,
      zip,
    );
    if (!tiers.length) return { ok: false, message: "Sorry, this item can’t ship to that country." };
    const prev = await getShipTo();
    await setShipTo({ ...prev, country, zip });
    return { ok: true, country, tiers: tiers.map((t) => ({ key: t.key, label: t.label, cents: t.cents, days: daysLabel(t) })) };
  } catch {
    return { ok: false, message: "We couldn’t get a shipping price right now. Please try again." };
  }
}

/** Cart: where to ship and which tier. */
export async function updateShipTo(form: FormData) {
  const prev = await getShipTo();
  const country = String(form.get("country") || prev.country);
  await setShipTo({
    country: isShipCountry(country) ? country : prev.country,
    zip: form.has("zip") ? String(form.get("zip") || "").trim().slice(0, 12) : prev.zip,
    tier: form.get("tier") === "express" ? "express" : form.get("tier") === "standard" ? "standard" : prev.tier,
  });
  revalidatePath("/cart");
}

/** Cart: ask for a freight quote on a large order. */
export async function requestFreightQuote(form: FormData) {
  const email = String(form.get("email") || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) redirect(`/cart?error=${encodeURIComponent("Enter a valid email for the freight quote.")}`);
  const cart = await loadCart(await getCartId());
  const items = cart?.items.filter((i) => i.variant.enabled && i.variant.offer) ?? [];
  if (!items.length) redirect("/cart");
  const priced = priceOrder(items.map((i) => ({ listCents: i.variant.priceCents, costCents: i.variant.offer?.cjSupplierVariant.supplierPriceCents, quantity: i.quantity })));
  const shipTo = await getShipTo();
  let parcelQuoteCents: number | null = null;
  try {
    parcelQuoteCents = (await quoteTiers(cartShipItems(cart, await cartBoxPicks(cart)), shipTo.country, shipTo.zip))[0]?.cents ?? null;
  } catch {
    /* comparison only */
  }
  await createFreightRequest({
    email,
    company: String(form.get("company") || "").trim().slice(0, 120) || undefined,
    notes: String(form.get("notes") || "").trim().slice(0, 2000),
    country: shipTo.country,
    postalCode: shipTo.zip,
    items: items.map((i, n) => ({
      title: i.variant.product.title,
      option: i.variant.name,
      quantity: i.quantity,
      unitCents: priced.unitCents[n],
      pid: i.variant.offer?.supplierProductId ?? null,
    })),
    subtotalCents: priced.totalCents,
    parcelQuoteCents,
  });
  redirect("/cart?freight=sent");
}

/** Box page: add a mystery box. Its contents are drawn now (hidden) so shipping can be quoted. */
export async function addBoxToCart(form: FormData) {
  const box = await prisma.mysteryBox.findUnique({ where: { id: String(form.get("boxId") || "") } });
  if (!box || box.status !== "PUBLISHED") redirect("/boxes");
  const picks = drawBox(await loadPool(box.id), box);
  if (!picks) redirect(`/boxes/${box.slug}?error=${encodeURIComponent("This box is sold out right now. Check back soon.")}`);
  const cartId = await getOrCreateCartId();
  await prisma.cartBox.create({ data: { cartId, boxId: box.id, picksJson: JSON.stringify(picks.map((p) => p.variantId)) } });
  revalidatePath("/", "layout");
  redirect("/cart");
}

export async function removeCartBox(form: FormData) {
  const cartId = await getCartId();
  if (cartId) await prisma.cartBox.deleteMany({ where: { id: String(form.get("id") || ""), cartId } });
  revalidatePath("/", "layout");
}
