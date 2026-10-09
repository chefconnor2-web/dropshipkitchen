// Buying a hotel stay: the shopper picks a room in the chat, enters the lead guest on our page, and we hold the
// rate with LiteAPI (prebook) before charging them with Stripe. Only once Stripe says paid do we book the held
// rate, paid by the LiteAPI account card. Like flights, a booking moves PENDING_PAYMENT → BOOKING atomically so a
// webhook retry and the stay page can't book twice.
//
// Money rules: the shopper pays the held price + our fee, never more than they saw without being asked again. If
// LiteAPI refuses the booking, they're refunded in full automatically. If we can't tell whether it booked (a
// timeout), nothing is refunded and the merchant is alerted: refunding a room that was actually booked loses it.

import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { stripe } from "@/lib/stripe";
import { sendEmail } from "@/lib/email";
import { newOrderNumber } from "@/lib/orders";
import { orderViewToken } from "@/lib/session";
import { bookRate, LiteapiError, prebook } from "@/lib/liteapi";
import { liteOfferId, offerCard, stayWithFee } from "@/lib/hotels";
import { shortDate, stayPrice, type HotelCard } from "@/lib/flights-shared";
import { normalizePhone } from "@/lib/flight-booking";

export const HOTEL_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  BOOKING: "BOOKING",
  BOOKED: "BOOKED",
  FAILED_REFUNDED: "FAILED_REFUNDED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
} as const;

const NAME = /^[\p{L}][\p{L}' .-]{0,59}$/u;

export function stayToken(bookingId: string): Promise<string> {
  return orderViewToken(`hotel\n${bookingId}`);
}

export async function stayUrl(b: { id: string; number: string }): Promise<string> {
  return `${config.siteUrl}/hotels/stay/${b.number}?t=${await stayToken(b.id)}`;
}

export function stayLabel(c: Pick<HotelCard, "name" | "checkin" | "checkout" | "nights">): string {
  return `${c.name}, ${shortDate(c.checkin)} – ${shortDate(c.checkout)} (${c.nights} night${c.nights === 1 ? "" : "s"})`;
}

export interface StartResult {
  url?: string;
  error?: string;
  newPriceCents?: number;
}

/** Holds the rate, saves the booking and opens Stripe Checkout. `offerId` is our card id from the booking link. */
export async function startHotelCheckout(input: { offerId: string; shownCents: number; form: FormData; customerId: string | null }): Promise<StartResult> {
  const card = await offerCard(input.offerId);
  if (!card) return { error: "We couldn't find this room any more. Go back to the chat and search again." };
  const firstName = String(input.form.get("firstName") ?? "").trim();
  const lastName = String(input.form.get("lastName") ?? "").trim();
  if (!NAME.test(firstName) || !NAME.test(lastName)) return { error: "Enter the lead guest's first and last name as on their ID." };
  const email = String(input.form.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { error: "Enter a valid email for the confirmation." };
  const phone = normalizePhone(String(input.form.get("phone") ?? ""));
  if (!phone) return { error: "Enter a phone number with country code (the hotel may need to reach you)." };

  let held;
  try {
    held = await prebook(liteOfferId(card));
  } catch (e) {
    console.error("[hotels] prebook failed:", e instanceof Error ? e.message : e);
    return { error: e instanceof LiteapiError && e.status && e.status < 500 ? "This room is no longer available at that price. Go back to the chat and search again." : "We couldn't reach the hotel just now. Please try again in a minute." };
  }
  if (held.currency && held.currency !== card.currency) return { error: "The hotel changed the price currency. Go back to the chat and search again." };
  const price = stayWithFee(held.price);
  // Never charge more than the shopper saw without asking again.
  if (price > input.shownCents) return { newPriceCents: price, error: `The hotel changed this stay to ${stayPrice({ priceCents: price, currency: card.currency })}. Check the details and book again.` };

  const booking = await prisma.hotelBooking.create({
    data: {
      number: newOrderNumber().replace(/^([^-]+)-/, "$1-HT-"),
      offerId: liteOfferId(card),
      prebookId: held.prebookId,
      cardJson: JSON.stringify(card),
      liteAmount: String(held.price),
      currency: card.currency,
      priceCents: price,
      firstName,
      lastName,
      email,
      phone,
      customerId: input.customerId,
    },
  });
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: card.currency.toLowerCase(),
          unit_amount: price,
          product_data: { name: `Hotel: ${card.name}`, description: `${shortDate(card.checkin)} – ${shortDate(card.checkout)} · ${card.room} · ${card.adults + card.childAges.length} guest${card.adults + card.childAges.length > 1 ? "s" : ""}` },
        },
      },
    ],
    metadata: { hotelBookingId: booking.id, bookingNumber: booking.number },
    payment_intent_data: { metadata: { hotelBookingId: booking.id } },
    success_url: `${config.siteUrl}/hotels/stay/${booking.number}?s={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.siteUrl}/hotels/book/${encodeURIComponent(card.id)}`,
  });
  await prisma.hotelBooking.update({ where: { id: booking.id }, data: { stripeSessionId: session.id } });
  return { url: session.url! };
}

/** Books with LiteAPI once Stripe says the shopper paid. Idempotent: safe from the webhook and the stay page. */
export async function completeHotelBooking(session: Pick<Stripe.Checkout.Session, "id" | "metadata" | "payment_status" | "payment_intent">) {
  const id = session.metadata?.hotelBookingId;
  if (!id || session.payment_status !== "paid") return null;
  const intent = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  const locked = await prisma.hotelBooking.updateMany({
    where: { id, status: HOTEL_STATUS.PENDING_PAYMENT, stripeSessionId: session.id },
    data: { status: HOTEL_STATUS.BOOKING, paidAt: new Date(), stripePaymentIntent: intent },
  });
  if (locked.count === 0) return prisma.hotelBooking.findUnique({ where: { id } });
  const b = await prisma.hotelBooking.findUniqueOrThrow({ where: { id } });
  try {
    const r = await bookRate(b.prebookId, { firstName: b.firstName, lastName: b.lastName, email: b.email }, b.number);
    // The account card pays LiteAPI's price for the hold: it must not be more than the shopper paid for.
    if (r.price != null && Number(r.price) > Number(b.liteAmount) + 0.005) {
      const message = `LiteAPI booked ${r.bookingId} at ${r.currency ?? b.currency} ${r.price}, above the held ${b.liteAmount}. Check it in the LiteAPI dashboard.`;
      await merchantAlert(b.number, message);
    }
    const booked = await prisma.hotelBooking.update({
      where: { id: b.id },
      data: { status: HOTEL_STATUS.BOOKED, liteBookingId: r.bookingId, confirmationCode: r.hotelConfirmationCode ?? r.bookingId, bookedAt: new Date(), error: null },
    });
    await sendStayEmail(booked.id, "confirmation");
    return booked;
  } catch (e) {
    // LiteAPI said no (4xx): nothing was booked, refund. Anything else (timeout, 5xx): it may have been booked.
    if (e instanceof LiteapiError && e.status && e.status >= 400 && e.status < 500) return refund(b.id, `The hotel couldn't confirm the booking: ${e.message.replace(/^LiteAPI: /, "")}`);
    const message = `LiteAPI didn't confirm in time (${e instanceof Error ? e.message : e}). Check the LiteAPI dashboard for booking ${b.number} before refunding.`;
    const r = await prisma.hotelBooking.update({ where: { id: b.id }, data: { status: HOTEL_STATUS.NEEDS_REVIEW, error: message } });
    await merchantAlert(r.number, message);
    return r;
  }
}

async function refund(bookingId: string, reason: string) {
  const b = await prisma.hotelBooking.findUniqueOrThrow({ where: { id: bookingId } });
  let refundId: string | null = null;
  let refundError = "";
  try {
    if (b.stripePaymentIntent) refundId = (await stripe().refunds.create({ payment_intent: b.stripePaymentIntent, reason: "requested_by_customer", metadata: { hotelBookingId: b.id } })).id;
  } catch (e) {
    refundError = ` The automatic refund failed (${e instanceof Error ? e.message : e}): refund it in Stripe.`;
  }
  const r = await prisma.hotelBooking.update({
    where: { id: b.id },
    data: { status: refundError ? HOTEL_STATUS.NEEDS_REVIEW : HOTEL_STATUS.FAILED_REFUNDED, stripeRefundId: refundId, error: reason + refundError },
  });
  if (refundError) await merchantAlert(b.number, reason + refundError);
  else await sendStayEmail(b.id, "refunded");
  return r;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function sendStayEmail(bookingId: string, kind: "confirmation" | "refunded") {
  const b = await prisma.hotelBooking.findUniqueOrThrow({ where: { id: bookingId } });
  const card = JSON.parse(b.cardJson) as HotelCard;
  const price = stayPrice({ priceCents: b.priceCents, currency: b.currency });
  const m =
    kind === "confirmation"
      ? {
          subject: `Booked: ${card.name} · ${shortDate(card.checkin)} – ${shortDate(card.checkout)}`,
          text: `Your hotel is booked.\n\nConfirmation: ${b.confirmationCode}\nHotel: ${card.name}\n${card.address ? card.address + "\n" : ""}Check-in: ${shortDate(card.checkin)} · Check-out: ${shortDate(card.checkout)} (${card.nights} night${card.nights === 1 ? "" : "s"})\nRoom: ${card.room} · ${card.board}\nLead guest: ${b.firstName} ${b.lastName}\n\nPaid: ${price}${card.refundable === false ? " (non-refundable)" : ""}\n\nYour stay: ${await stayUrl(b)}\n\nShow the confirmation and your ID at the front desk. Some hotels collect a local city tax at check-in.\n\n${config.storeName}`,
        }
      : {
          subject: `We couldn't book your hotel, refunded ${price}`,
          text: `Sorry, we couldn't book ${stayLabel(card)}.\n\n${b.error ?? ""}\n\nYour payment of ${price} has been refunded in full to your card (it can take 5-10 days to appear).\n\nAsk the assistant to search again: ${config.siteUrl}\n\n${config.storeName}`,
        };
  await sendEmail({ to: b.email, kind: `hotel_${kind}`, subject: m.subject, text: m.text, html: `<pre style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${esc(m.text)}</pre>` });
}

async function merchantAlert(number: string, message: string) {
  if (!config.email.storeEmail) return;
  const text = `Hotel booking ${number} needs you:\n\n${message}\n\n${config.siteUrl}/admin/hotels`;
  await sendEmail({ to: config.email.storeEmail, kind: "hotel_needs_review", subject: `Hotel booking ${number} needs review`, text, html: `<pre>${esc(text)}</pre>` });
}
