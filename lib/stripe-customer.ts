// Saved cards and in-chat checkout. Each signed-in customer gets a Stripe customer, so Checkout offers "Save my
// card" (Stripe keeps it; Chit never sees the number) and shows saved cards next time. From the Chit card in
// Claude, the customer can then pay a booking with their saved card in one tap (only that tap can charge:
// the tool is visible to the card, not the model). Checkout opened from the card is Stripe's embedded form,
// shown inside the card; the same session also opens as a page on Chit (/pay/<id>) in a browser.

import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { stripe } from "@/lib/stripe";

export const publishableKey = () => process.env.STRIPE_PUBLISHABLE_KEY?.trim() || "";

/** The customer's Stripe customer id, made the first time it's needed. */
export async function stripeCustomerFor(customerId: string): Promise<string> {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true, name: true, stripeCustomerId: true } });
  if (c.stripeCustomerId) return c.stripeCustomerId;
  const made = await stripe().customers.create({ email: c.email, ...(c.name ? { name: c.name } : {}), metadata: { customerId } });
  // Two at once: keep whichever was saved first.
  const updated = await prisma.customer.updateMany({ where: { id: customerId, stripeCustomerId: null }, data: { stripeCustomerId: made.id } });
  if (updated.count) return made.id;
  return (await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { stripeCustomerId: true } })).stripeCustomerId!;
}

/**
 * Checkout params for a signed-in customer: their Stripe customer (instead of a bare email), with "save my card"
 * and their saved cards shown. `embedded`: Stripe's embedded form (no hosted page), returning where success_url
 * pointed; card payments finish without leaving the form.
 */
export async function forCustomer(params: Stripe.Checkout.SessionCreateParams, customerId: string | null | undefined, embedded: boolean): Promise<Stripe.Checkout.SessionCreateParams> {
  let p: Stripe.Checkout.SessionCreateParams = { ...params };
  if (customerId) {
    const customer = await stripeCustomerFor(customerId).catch((e) => {
      console.error("[stripe] customer:", e instanceof Error ? e.message : e);
      return null;
    });
    if (customer) {
      delete p.customer_email;
      p = { ...p, customer, saved_payment_method_options: { payment_method_save: "enabled", allow_redisplay_filters: ["always"] } };
    }
  }
  if (embedded) {
    const { success_url, cancel_url: _cancel, ...rest } = p;
    p = { ...rest, ui_mode: "embedded_page", return_url: success_url ?? `${config.siteUrl}/`, redirect_on_completion: "if_required" };
  }
  return p;
}

/** Where to pay: Stripe's hosted page, or for an embedded session, its page on Chit. */
export function checkoutUrl(s: Pick<Stripe.Checkout.Session, "id" | "url">): string {
  return s.url ?? `${config.siteUrl}/pay/${s.id}`;
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
}

/** The customer's most recent card saved for reuse, or null. */
export async function savedCard(customerId: string): Promise<SavedCard | null> {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { stripeCustomerId: true } });
  if (!c?.stripeCustomerId) return null;
  const list = await stripe().customers.listPaymentMethods(c.stripeCustomerId, { type: "card", limit: 5, allow_redisplay: "always" }).catch(() => null);
  const pm = list?.data.sort((a, b) => b.created - a.created)[0];
  return pm?.card ? { id: pm.id, brand: pm.card.brand, last4: pm.card.last4 } : null;
}

export const cardLabel = (c: SavedCard) => `${c.brand.charAt(0).toUpperCase()}${c.brand.slice(1)} •••${c.last4}`;

type Paid = { ok: true } | { ok: false; error: string; needsLink?: boolean };

/**
 * Charges the customer's saved card for a booking waiting for payment, then books it exactly as a paid Checkout
 * would (completeFlightBooking / completeHotelBooking). The open Checkout session is expired first, so the same
 * booking can't also be paid there. If the bank wants a check (3-D Secure), nothing is charged: use the link.
 */
export async function payBookingWithSavedCard(kind: "flight" | "hotel", bookingId: string, customerId: string): Promise<Paid> {
  const card = await savedCard(customerId);
  if (!card) return { ok: false, error: "No saved card yet. Pay once with the link and tick “Save my card”.", needsLink: true };
  const customer = await stripeCustomerFor(customerId);
  const b = kind === "flight" ? await prisma.flightBooking.findUnique({ where: { id: bookingId } }) : await prisma.hotelBooking.findUnique({ where: { id: bookingId } });
  if (!b || b.status !== "PENDING_PAYMENT") return { ok: false, error: "This booking isn't waiting for payment." };
  // The open checkout must not be payable too. Paid there already: just finish it.
  if (b.stripeSessionId?.startsWith("cs_")) {
    const s = await stripe().checkout.sessions.retrieve(b.stripeSessionId).catch(() => null);
    if (s?.status === "complete") return { ok: false, error: "It's already paid. It will show as booked in a moment." };
    if (s?.status === "open") {
      const expired = await stripe().checkout.sessions.expire(s.id).then(() => true).catch(() => false);
      if (!expired) return { ok: false, error: "Payment is in progress on the checkout page. Finish it there." };
    }
  }
  const metaKey = kind === "flight" ? "flightBookingId" : "hotelBookingId";
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe().paymentIntents.create(
      {
        amount: b.priceCents,
        currency: b.currency.toLowerCase(),
        customer,
        payment_method: card.id,
        payment_method_types: ["card"],
        confirm: true,
        error_on_requires_action: true,
        description: `${kind === "flight" ? "Flight" : "Hotel"} ${b.number}`,
        metadata: { [metaKey]: b.id, bookingNumber: b.number, via: "saved_card" },
      },
      { idempotencyKey: `saved-card-${b.id}-${b.updatedAt.getTime()}` },
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error && /authentication|requires_action/i.test(e.message) ? "Your bank wants to confirm this payment. Use the pay link." : `The card was declined${e instanceof Error ? ` (${e.message})` : ""}. Use the pay link.`, needsLink: true };
  }
  if (pi.status !== "succeeded") return { ok: false, error: "The payment didn't go through. Use the pay link.", needsLink: true };
  // From here it's paid: book it the same way a paid checkout does (refunds use the payment intent).
  if (kind === "flight") await prisma.flightBooking.update({ where: { id: b.id }, data: { stripeSessionId: pi.id } });
  else await prisma.hotelBooking.update({ where: { id: b.id }, data: { stripeSessionId: pi.id } });
  const done = { id: pi.id, metadata: { [metaKey]: b.id }, payment_status: "paid" as const, payment_intent: pi.id };
  if (kind === "flight") await (await import("@/lib/flight-booking")).completeFlightBooking(done);
  else await (await import("@/lib/hotel-booking")).completeHotelBooking(done);
  return { ok: true };
}

/** Stripe's embedded checkout (called "embedded_page" since the 2026 API; "embedded" before). */
export const isEmbedded = (mode: string | null | undefined) => mode === "embedded_page" || mode === "embedded";
