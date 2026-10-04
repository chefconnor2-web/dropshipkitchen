// The AI assistant subscription (see lib/plan.ts for the price). The first payment is the first month plus the
// shipping of a free welcome mystery box: that invoice becomes a box order (items drawn at random from the box's
// pool within the plan's margin), waiting for the merchant's approval like any other order. Later months are the
// assistant only and are recorded as SubscriptionPayments (they count toward spend tiers). Invoices are handled
// from the webhook, the subscribe success page, and syncSubscriptions (admin), whichever sees them first; never twice.

import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { stripe } from "@/lib/stripe";
import { allocatePrice, drawBox, loadPool } from "@/lib/mystery";
import { newOrderNumber, ORDER_STATUS } from "@/lib/orders";
import { linkOrderToCustomer } from "@/lib/customers";
import { sendOrderEmail } from "@/lib/order-emails";
import { countryLabel, estimateFromHistory, isShipCountry, quoteCart } from "@/lib/shipping";
import { processSingleton } from "@/lib/singleton";
import { getPlan, planRules } from "@/lib/plan";

/** Monthly shipping for a box to a country: a live quote for a sample draw, else an estimate. */
export async function boxShippingCents(boxId: string, country: string, zip: string): Promise<number | null> {
  const box = await prisma.mysteryBox.findUnique({ where: { id: boxId } });
  if (!box) return null;
  const picks = drawBox(await loadPool(box.id), planRules(box, await getPlan()));
  if (!picks) return null;
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: picks.map((p) => p.variantId) } },
    include: { offer: { include: { cjSupplierVariant: true } } },
  });
  const items = variants.flatMap((v) => {
    const sv = v.offer?.cjSupplierVariant;
    return sv ? [{ vid: sv.cjVariantId, quantity: 1, inventoryJson: sv.inventoryJson, weightGrams: sv.weightGrams }] : [];
  });
  const quote = await quoteCart(items, country, zip).catch(() => null);
  if (quote?.tiers.length) return quote.tiers[0].cents;
  return (await estimateFromHistory(items, country))?.cents ?? null;
}

/** A Stripe Checkout page for the subscription: the first month plus shipping for a free welcome box. */
export async function startBoxSubscription(input: { boxId: string; country: string; zip: string; customer?: { email: string; stripeCustomerId: string | null } | null }) {
  const box = await prisma.mysteryBox.findUnique({ where: { id: input.boxId } });
  if (!box || box.status !== "PUBLISHED") throw new Error("This box isn’t available.");
  if (!isShipCountry(input.country)) throw new Error("Choose where we’re shipping to.");
  const plan = await getPlan();
  const shippingCents = await boxShippingCents(box.id, input.country, input.zip);
  if (shippingCents == null) throw new Error("This box is sold out or can’t ship to you right now. Pick another one, or check back soon.");
  const meta = { kind: "assistant_subscription", boxId: box.id, shippingCents: String(shippingCents), country: input.country };
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [
      { quantity: 1, price_data: { currency: "usd", unit_amount: plan.priceCents, recurring: { interval: "month" }, product_data: { name: `${config.storeName} AI assistant`, description: `Monthly subscription. Your first month includes a free ${box.name} mystery box.` } } },
      // One-time: charged with the first month only.
      ...(shippingCents > 0
        ? [{ quantity: 1, price_data: { currency: "usd", unit_amount: shippingCents, product_data: { name: `Shipping for your free ${box.name} to ${countryLabel(input.country)}` } } }]
        : []),
    ],
    ...(input.customer?.stripeCustomerId ? { customer: input.customer.stripeCustomerId } : input.customer?.email ? { customer_email: input.customer.email } : {}),
    // The welcome box ships to the address given here, in the country the shipping was quoted for.
    shipping_address_collection: { allowed_countries: [input.country as "US"] },
    phone_number_collection: { enabled: true },
    subscription_data: { description: `${config.storeName} AI assistant (first month includes a free ${box.name})`, metadata: meta },
    metadata: meta,
    success_url: `${config.siteUrl}/subscribe/complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.siteUrl}/boxes/${box.slug}`,
  });
  return session.url!;
}

function periodEnd(sub: Stripe.Subscription): Date | null {
  const end = sub.items?.data?.[0]?.current_period_end;
  return end ? new Date(end * 1000) : null;
}

/** Saves (or updates) our copy of a Stripe subscription, linked to the customer with this email. */
async function saveSubscription(sub: Stripe.Subscription, fallback: { email?: string | null; name?: string | null; phone?: string | null; shipping?: unknown } = {}) {
  const stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const existing = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: sub.id } });
  if (existing) {
    return prisma.subscription.update({
      where: { id: existing.id },
      data: { status: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end, currentPeriodEnd: periodEnd(sub), ...(fallback.shipping ? { shippingAddressJson: JSON.stringify(fallback.shipping) } : {}) },
    });
  }
  let email = fallback.email?.trim().toLowerCase();
  if (!email && typeof sub.customer !== "string" && !("deleted" in sub.customer && sub.customer.deleted)) email = (sub.customer as Stripe.Customer).email?.toLowerCase();
  if (!email) {
    const c = await stripe().customers.retrieve(stripeCustomerId);
    email = !("deleted" in c && c.deleted) ? (c as Stripe.Customer).email?.toLowerCase() ?? undefined : undefined;
  }
  if (!email) throw new Error(`Stripe subscription ${sub.id} has no customer email.`);
  const customer = await prisma.customer.upsert({
    where: { email },
    create: { email, name: fallback.name ?? null, phone: fallback.phone ?? null, stripeCustomerId },
    update: { stripeCustomerId, ...(fallback.name ? { name: fallback.name } : {}), ...(fallback.phone ? { phone: fallback.phone } : {}) },
  });
  const boxId = sub.metadata.boxId;
  const box = boxId ? await prisma.mysteryBox.findUnique({ where: { id: boxId } }) : null;
  const shippingCents = Number(sub.metadata.shippingCents) || 0;
  // Subscription items are the recurring prices only (the welcome box's shipping was a one-time charge).
  const priceCents = (sub.items?.data ?? []).reduce((n, i) => n + (i.price?.unit_amount ?? 0) * (i.quantity ?? 1), 0);
  return prisma.subscription.create({
    data: {
      customerId: customer.id,
      boxId: boxId ?? "",
      boxName: box?.name ?? "Mystery box",
      stripeSubscriptionId: sub.id,
      status: sub.status,
      priceCents: Math.max(0, priceCents),
      shippingCents,
      shipCountry: sub.metadata.country ?? "",
      shippingAddressJson: fallback.shipping ? JSON.stringify(fallback.shipping) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodEnd: periodEnd(sub),
    },
  });
}

/** After a subscription checkout: our subscription and customer, and the first month's box order. */
export async function completeSubscriptionCheckout(sessionOrId: string | Stripe.Checkout.Session) {
  const id = typeof sessionOrId === "string" ? sessionOrId : sessionOrId.id;
  const session = await stripe().checkout.sessions.retrieve(id, { expand: ["subscription"] });
  if (session.mode !== "subscription" || !session.subscription || session.status !== "complete") return null;
  const sub = typeof session.subscription === "string" ? await stripe().subscriptions.retrieve(session.subscription) : session.subscription;
  const shipping = session.collected_information?.shipping_details ?? null;
  const row = await saveSubscription(sub, {
    email: session.customer_details?.email,
    name: session.customer_details?.name,
    phone: session.customer_details?.phone,
    shipping,
  });
  const invoiceId = typeof session.invoice === "string" ? session.invoice : session.invoice?.id;
  if (invoiceId) await orderForInvoice(invoiceId);
  // The success page signs the subscriber in, but only soon after paying: an old checkout link in someone's
  // browser history shouldn't open their account.
  const fresh = Date.now() / 1000 - session.created < 2 * 3600;
  return { ...row, canSignIn: fresh };
}

const locks = processSingleton("box-invoice-locks", () => new Map<string, Promise<unknown>>());

/** Handles one paid subscription invoice (once): the first becomes the welcome box order, later ones a payment. */
export function orderForInvoice(invoiceId: string): Promise<string | null> {
  const running = locks.get(invoiceId) as Promise<string | null> | undefined;
  if (running) return running;
  const p = createOrderForInvoice(invoiceId).finally(() => locks.delete(invoiceId));
  locks.set(invoiceId, p);
  return p;
}

async function createOrderForInvoice(invoiceId: string): Promise<string | null> {
  const done = await prisma.order.findFirst({ where: { stripeInvoiceId: invoiceId }, select: { id: true } });
  if (done) return done.id;
  if (await prisma.subscriptionPayment.findUnique({ where: { invoiceId }, select: { invoiceId: true } })) return null;
  const invoice = await stripe().invoices.retrieve(invoiceId, { expand: ["payments"] });
  if (invoice.status !== "paid") return null;
  const subRef = invoice.parent?.subscription_details?.subscription;
  if (!subRef) return null;
  const stripeSubId = typeof subRef === "string" ? subRef : subRef.id;
  let sub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: stripeSubId }, include: { customer: true } });
  if (!sub) {
    await saveSubscription(await stripe().subscriptions.retrieve(stripeSubId), { email: invoice.customer_email, name: invoice.customer_name });
    sub = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: stripeSubId }, include: { customer: true } });
  }
  const payment = invoice.payments?.data?.[0]?.payment;
  const paymentIntent = typeof payment?.payment_intent === "string" ? payment.payment_intent : payment?.payment_intent?.id ?? null;
  const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : new Date();

  // Only the first month comes with a box; later months are the assistant only (recorded for spend tiers).
  const first = invoice.billing_reason === "subscription_create" && !(await prisma.order.findFirst({ where: { subscriptionId: sub.id }, select: { id: true } }));
  if (!first) {
    const data = { subscriptionId: sub.id, customerId: sub.customerId, amountCents: invoice.amount_paid ?? 0, paidAt };
    await prisma.subscriptionPayment.upsert({ where: { invoiceId }, create: { invoiceId, ...data }, update: data });
    return null;
  }

  // Draw the welcome box within the plan's margin. A pool that can't make one still creates the order, flagged.
  const box = await prisma.mysteryBox.findUnique({ where: { id: sub.boxId } });
  const picks = box ? drawBox(await loadPool(box.id), planRules(box, await getPlan())) : null;
  const variants = picks
    ? await prisma.productVariant.findMany({ where: { id: { in: picks.map((p) => p.variantId) } }, include: { product: true, offer: { include: { cjSupplierVariant: true } } } })
    : [];
  const byId = new Map(variants.map((v) => [v.id, v]));
  const prices = picks ? allocatePrice(sub.priceCents, picks) : [];
  const group = `sub-${invoiceId}`;

  const order = await prisma.order.create({
    data: {
      number: newOrderNumber(),
      status: ORDER_STATUS.AWAITING_MERCHANT_APPROVAL,
      customerId: sub.customerId,
      email: sub.customer.email,
      customerName: sub.customer.name,
      customerPhone: sub.customer.phone,
      shippingAddressJson: sub.shippingAddressJson,
      subtotalCents: sub.priceCents,
      shippingCents: sub.shippingCents,
      customerShipCountry: sub.shipCountry || null,
      paidAt,
      stripePaymentIntent: paymentIntent,
      stripeInvoiceId: invoiceId,
      subscriptionId: sub.id,
      decisionNote: picks
        ? "Welcome box for a new AI assistant subscriber (first month + shipping paid)."
        : `The ${sub.boxName} pool couldn’t make a welcome box within the plan's margin (sold out, or nothing cheap enough). Add stock to the pool, or decline and refund.`,
      items: {
        create: (picks ?? []).flatMap((p, n) => {
          const v = byId.get(p.variantId);
          const offer = v?.offer;
          if (!v || !offer) return [];
          return [
            {
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
              mysteryBoxName: sub.boxName,
              mysteryBoxGroup: group,
            },
          ];
        }),
      },
    },
  });
  await linkOrderToCustomer(order.id);
  await sendOrderEmail(order.id, "order_confirmation");
  await sendOrderEmail(order.id, "merchant_new_order");
  return order.id;
}

/** Keeps a subscription's status in step with Stripe (webhook: customer.subscription.updated / deleted). */
export async function updateSubscriptionFromStripe(sub: Stripe.Subscription) {
  const existing = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: sub.id } });
  if (existing) await prisma.subscription.update({ where: { id: existing.id }, data: { status: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end, currentPeriodEnd: periodEnd(sub) } });
}

/**
 * Catches up with Stripe without a webhook: refreshes every subscription's status and turns any paid invoice
 * that has no order yet into a box order. Returns how many orders it created.
 */
export async function syncSubscriptions(): Promise<{ checked: number; created: number; errors: string[] }> {
  const subs = await prisma.subscription.findMany({ where: { OR: [{ status: { not: "canceled" } }, { updatedAt: { gte: new Date(Date.now() - 45 * 86_400_000) } }] }, take: 200 });
  let created = 0;
  const errors: string[] = [];
  for (const s of subs) {
    try {
      await updateSubscriptionFromStripe(await stripe().subscriptions.retrieve(s.stripeSubscriptionId));
      const invoices = await stripe().invoices.list({ subscription: s.stripeSubscriptionId, status: "paid", limit: 12 });
      for (const inv of invoices.data) {
        if (!inv.id) continue;
        if (await prisma.order.findFirst({ where: { stripeInvoiceId: inv.id }, select: { id: true } })) continue;
        if (await prisma.subscriptionPayment.findUnique({ where: { invoiceId: inv.id }, select: { invoiceId: true } })) continue;
        if (await orderForInvoice(inv.id)) created++;
      }
    } catch (e) {
      errors.push(`${s.boxName} (${s.stripeSubscriptionId}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: subs.length, created, errors };
}

/** A Stripe billing portal link where the subscriber can update their card, address or cancel. */
export async function billingPortalUrl(stripeCustomerId: string, returnPath = "/account") {
  const s = await stripe().billingPortal.sessions.create({ customer: stripeCustomerId, return_url: `${config.siteUrl}${returnPath}` });
  return s.url;
}
