// Buying a flight: the shopper fills in passengers on our page, pays us with Stripe, and only then do we book
// the offer with Duffel (paid from our Duffel balance). Each booking is created before payment with a snapshot
// of the offer, and moves PENDING_PAYMENT → BOOKING atomically, so a webhook retry and the success page can't
// book twice.
//
// Money rules: the shopper pays Duffel's total + our fee. If the airline's price went up before we could book,
// or Duffel refuses the booking, the shopper is refunded in full automatically. If we can't tell whether Duffel
// booked it (a timeout), nothing is refunded and the merchant is alerted: refunding a ticket that was actually
// issued would lose the fare.

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { stripe } from "@/lib/stripe";
import { sendEmail } from "@/lib/email";
import { newOrderNumber } from "@/lib/orders";
import { orderViewToken } from "@/lib/session";
import { createOrder, DuffelError, getOffer, type DuffelOffer, type DuffelOrderPassenger } from "@/lib/duffel";
import { priceWithFee, toCard } from "@/lib/flights";
import { clock, flightPrice, shortDate, type FlightCard } from "@/lib/flights-shared";
import type Stripe from "stripe";

export const FLIGHT_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  BOOKING: "BOOKING",
  BOOKED: "BOOKED",
  FAILED_REFUNDED: "FAILED_REFUNDED",
  /** Duffel didn't answer clearly: the merchant checks the Duffel dashboard before anything is refunded. */
  NEEDS_REVIEW: "NEEDS_REVIEW",
} as const;

export type PassengerKind = "adult" | "child" | "infant";

export interface PassengerSlot {
  id: string;
  kind: PassengerKind;
  age: number | null;
}

/** Who the offer was priced for, in Duffel's order. */
export function passengerSlots(offer: Pick<DuffelOffer, "passengers">): PassengerSlot[] {
  return offer.passengers.map((p) => {
    const age = typeof p.age === "number" ? p.age : null;
    const kind: PassengerKind = p.type === "infant_without_seat" || (age != null && age < 2) ? "infant" : p.type === "child" || (age != null && age < 12) ? "child" : "adult";
    return { id: p.id, kind, age };
  });
}

export interface PassengerInput {
  id: string;
  title: DuffelOrderPassenger["title"];
  gender: DuffelOrderPassenger["gender"];
  given_name: string;
  family_name: string;
  born_on: string;
  passport?: { number: string; country: string; expires: string };
}

const TITLES = ["mr", "ms", "mrs", "miss", "dr"] as const;
// Airlines take Latin letters only, as printed on the passport.
const NAME = /^[A-Za-z][A-Za-z' -]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads and checks the passenger form. Returns the passengers or a message for the shopper. */
export function parsePassengers(form: FormData, slots: PassengerSlot[], needPassport: boolean, today = new Date().toISOString().slice(0, 10)): PassengerInput[] | string {
  const out: PassengerInput[] = [];
  for (const [i, slot] of slots.entries()) {
    const who = slots.length > 1 ? `Passenger ${i + 1}` : "The passenger";
    const f = (k: string) => String(form.get(`${k}_${i}`) ?? "").trim();
    const title = f("title") as PassengerInput["title"];
    const gender = f("gender") as PassengerInput["gender"];
    const given = f("given").replace(/\s+/g, " ");
    const family = f("family").replace(/\s+/g, " ");
    const born = f("born");
    if (!TITLES.includes(title)) return `${who}: choose a title.`;
    if (gender !== "m" && gender !== "f") return `${who}: choose the gender shown on the passport.`;
    if (!NAME.test(given) || !NAME.test(family)) return `${who}: enter first and last names exactly as on the passport, in English letters.`;
    if (!DATE.test(born) || Number.isNaN(Date.parse(born)) || born >= today) return `${who}: enter a valid date of birth.`;
    const age = Math.floor((Date.parse(today) - Date.parse(born)) / (365.25 * 86400_000));
    if (slot.kind === "adult" && age < 12) return `${who} is booked as an adult, so must be 12 or older.`;
    if (slot.kind === "infant" && age >= 2) return `${who} is booked as an infant, so must be under 2.`;
    const p: PassengerInput = { id: slot.id, title, gender, given_name: given, family_name: family, born_on: born };
    if (needPassport) {
      const number = f("passport").replace(/\s+/g, "").toUpperCase();
      const country = f("passport_country").toUpperCase();
      const expires = f("passport_expiry");
      if (!/^[A-Z0-9]{5,20}$/.test(number)) return `${who}: enter the passport number.`;
      if (!/^[A-Z]{2}$/.test(country)) return `${who}: choose the passport's issuing country.`;
      if (!DATE.test(expires) || expires <= today) return `${who}: the passport must not be expired.`;
      p.passport = { number, country, expires };
    }
    out.push(p);
  }
  return out;
}

/** "+14165551234" from what people type; null when it can't be a phone number. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  const d = digits.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`; // Canada / US without the country code
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/** Duffel's passenger list: contact details on everyone, each infant travelling on an adult's lap. */
export function orderPassengers(passengers: PassengerInput[], slots: PassengerSlot[], email: string, phone: string): DuffelOrderPassenger[] {
  const adults = slots.filter((s) => s.kind === "adult").map((s) => s.id);
  const infants = slots.filter((s) => s.kind === "infant").map((s) => s.id);
  return passengers.map((p) => {
    const lap = adults.indexOf(p.id);
    return {
      id: p.id,
      title: p.title,
      gender: p.gender,
      given_name: p.given_name,
      family_name: p.family_name,
      born_on: p.born_on,
      email,
      phone_number: phone,
      ...(lap >= 0 && infants[lap] ? { infant_passenger_id: infants[lap] } : {}),
      ...(p.passport ? { identity_documents: [{ type: "passport" as const, unique_identifier: p.passport.number, issuing_country_code: p.passport.country, expires_on: p.passport.expires }] } : {}),
    };
  });
}

export function routeLabel(c: FlightCard): string {
  const first = c.slices[0];
  if (!first) return "Flight";
  const back = c.slices.length === 2 && c.slices[1].to === first.from;
  return `${first.from} → ${first.to}${back ? " (return)" : c.slices.length > 1 ? ` + ${c.slices.length - 1} more` : ""}`;
}

export function tripToken(bookingId: string): Promise<string> {
  return orderViewToken(`flight\n${bookingId}`);
}

// ---------- checkout ----------

export interface StartResult {
  url?: string;
  /** For the shopper, shown on the booking page. */
  error?: string;
  /** The fare moved: show the new price and ask again. */
  newPriceCents?: number;
}

/** Re-prices the offer, saves the booking and opens Stripe Checkout. */
export async function startFlightCheckout(input: { offerId: string; shownCents: number; form: FormData; customerId: string | null }): Promise<StartResult> {
  let offer: DuffelOffer;
  try {
    offer = await getOffer(input.offerId);
  } catch (e) {
    if (e instanceof DuffelError && e.status === 404) return { error: "This fare is no longer available. Go back to the chat and search again." };
    return { error: "We couldn't reach the airline just now. Please try again in a minute." };
  }
  if (Date.parse(offer.expires_at) < Date.now() + 60_000) return { error: "This fare has expired. Go back to the chat and search again for current prices." };
  const price = priceWithFee(offer.total_amount);
  // Never charge more than the shopper saw without asking again.
  if (price > input.shownCents) return { newPriceCents: price, error: `The airline changed this fare to ${flightPrice({ priceCents: price, currency: offer.total_currency })}. Check the details and book again.` };

  const slots = passengerSlots(offer);
  const passengers = parsePassengers(input.form, slots, offer.passenger_identity_documents_required === true);
  if (typeof passengers === "string") return { error: passengers };
  const email = String(input.form.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { error: "Enter a valid email for the e-ticket." };
  const phone = normalizePhone(String(input.form.get("phone") ?? ""));
  if (!phone) return { error: "Enter a phone number with country code (airlines text about delays)." };

  const card = toCard(offer);
  const booking = await prisma.flightBooking.create({
    data: {
      number: newOrderNumber().replace(/^([^-]+)-/, "$1-FL-"),
      offerId: offer.id,
      cardJson: JSON.stringify(card),
      duffelAmount: offer.total_amount,
      currency: offer.total_currency,
      priceCents: price,
      passengersJson: JSON.stringify(passengers),
      email,
      phone,
      customerId: input.customerId,
    },
  });
  const first = card.slices[0];
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: offer.total_currency.toLowerCase(),
          unit_amount: price,
          product_data: {
            name: `Flight ${routeLabel(card)}`,
            description: `${first ? `${shortDate(first.depart)} ${clock(first.depart)} · ` : ""}${card.airline} · ${passengers.length} passenger${passengers.length > 1 ? "s" : ""}`,
          },
        },
      },
    ],
    metadata: { flightBookingId: booking.id, bookingNumber: booking.number },
    payment_intent_data: { metadata: { flightBookingId: booking.id } },
    success_url: `${config.siteUrl}/flights/trip/${booking.number}?s={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.siteUrl}/flights/book/${encodeURIComponent(offer.id)}`,
  });
  await prisma.flightBooking.update({ where: { id: booking.id }, data: { stripeSessionId: session.id } });
  return { url: session.url! };
}

// ---------- after payment ----------

/** Books with Duffel once Stripe says the shopper paid. Idempotent: safe from the webhook and the trip page. */
export async function completeFlightBooking(session: Pick<Stripe.Checkout.Session, "id" | "metadata" | "payment_status" | "payment_intent">) {
  const id = session.metadata?.flightBookingId;
  if (!id || session.payment_status !== "paid") return null;
  const intent = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  const locked = await prisma.flightBooking.updateMany({
    where: { id, status: FLIGHT_STATUS.PENDING_PAYMENT, stripeSessionId: session.id },
    data: { status: FLIGHT_STATUS.BOOKING, paidAt: new Date(), stripePaymentIntent: intent },
  });
  if (locked.count === 0) return prisma.flightBooking.findUnique({ where: { id } });
  const b = await prisma.flightBooking.findUniqueOrThrow({ where: { id } });

  let offer: DuffelOffer;
  try {
    offer = await getOffer(b.offerId);
  } catch (e) {
    return refund(b.id, e instanceof DuffelError && e.status === 404 ? "The fare sold out before we could book it." : `We couldn't re-check the fare with the airline (${e instanceof Error ? e.message : e}).`);
  }
  // Our Duffel balance pays the airline's current total: it must not be more than the shopper paid for.
  if (offer.total_currency !== b.currency || Number(offer.total_amount) > Number(b.duffelAmount) + 0.005)
    return refund(b.id, `The airline raised the fare (now ${offer.total_currency} ${offer.total_amount}) before we could book it.`);

  try {
    const passengers = JSON.parse(b.passengersJson) as PassengerInput[];
    const order = await createOrder(offer, orderPassengers(passengers, passengerSlots(offer), b.email, b.phone), { booking: b.number });
    const booked = await prisma.flightBooking.update({
      where: { id: b.id },
      data: { status: FLIGHT_STATUS.BOOKED, duffelOrderId: order.id, bookingReference: order.booking_reference, bookedAt: new Date(), error: null },
    });
    await sendFlightEmail(booked.id, "confirmation");
    return booked;
  } catch (e) {
    // Duffel said no (4xx): nothing was booked, refund. Anything else (timeout, 5xx): it may have been booked.
    if (e instanceof DuffelError && e.status >= 400 && e.status < 500) return refund(b.id, `The airline couldn't confirm the booking: ${e.message}`);
    const message = `Duffel didn't confirm in time (${e instanceof Error ? e.message : e}). Check the Duffel dashboard for booking ${b.number} before refunding.`;
    const r = await prisma.flightBooking.update({ where: { id: b.id }, data: { status: FLIGHT_STATUS.NEEDS_REVIEW, error: message } });
    await merchantAlert(r.number, message);
    return r;
  }
}

async function refund(bookingId: string, reason: string) {
  const b = await prisma.flightBooking.findUniqueOrThrow({ where: { id: bookingId } });
  let refundId: string | null = null;
  let refundError = "";
  try {
    if (b.stripePaymentIntent) refundId = (await stripe().refunds.create({ payment_intent: b.stripePaymentIntent, reason: "requested_by_customer", metadata: { flightBookingId: b.id } })).id;
  } catch (e) {
    refundError = ` The automatic refund failed (${e instanceof Error ? e.message : e}): refund it in Stripe.`;
  }
  const r = await prisma.flightBooking.update({
    where: { id: b.id },
    data: { status: refundError ? FLIGHT_STATUS.NEEDS_REVIEW : FLIGHT_STATUS.FAILED_REFUNDED, stripeRefundId: refundId, error: reason + refundError },
  });
  if (refundError) await merchantAlert(b.number, reason + refundError);
  else await sendFlightEmail(b.id, "refunded");
  return r;
}

// ---------- emails ----------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function tripUrl(b: { id: string; number: string }): Promise<string> {
  return `${config.siteUrl}/flights/trip/${b.number}?t=${await tripToken(b.id)}`;
}

async function sendFlightEmail(bookingId: string, kind: "confirmation" | "refunded") {
  const b = await prisma.flightBooking.findUniqueOrThrow({ where: { id: bookingId } });
  const card = JSON.parse(b.cardJson) as FlightCard;
  const url = await tripUrl(b);
  const lines = card.slices.map((s) => `${shortDate(s.depart)}: ${s.from} ${clock(s.depart)} → ${s.to} ${clock(s.arrive)} (${card.airline})`).join("\n");
  const names = (JSON.parse(b.passengersJson) as PassengerInput[]).map((p) => `${p.given_name} ${p.family_name}`).join(", ");
  const price = flightPrice({ priceCents: b.priceCents, currency: b.currency });
  const m =
    kind === "confirmation"
      ? {
          subject: `Booked: ${routeLabel(card)} · confirmation ${b.bookingReference}`,
          text: `Your flight is booked.\n\nAirline confirmation (PNR): ${b.bookingReference}\nPassengers: ${names}\n\n${lines}\n\nPaid: ${price}\n\nYour trip: ${url}\n\nUse the confirmation code to check in with ${card.airline}.\n\n${config.storeName}`,
        }
      : {
          subject: `We couldn't book your flight, refunded ${price}`,
          text: `Sorry, we couldn't book your flight ${routeLabel(card)}.\n\n${b.error ?? ""}\n\nYour payment of ${price} has been refunded in full to your card (it can take 5-10 days to appear).\n\nAsk the assistant to search again for current fares: ${config.siteUrl}\n\n${config.storeName}`,
        };
  await sendEmail({ to: b.email, kind: `flight_${kind}`, subject: m.subject, text: m.text, html: `<pre style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${esc(m.text)}</pre>` });
}

async function merchantAlert(number: string, message: string) {
  if (!config.email.storeEmail) return;
  const text = `Flight booking ${number} needs you:\n\n${message}\n\n${config.siteUrl}/admin/flights`;
  await sendEmail({ to: config.email.storeEmail, kind: "flight_needs_review", subject: `Flight booking ${number} needs review`, text, html: `<pre>${esc(text)}</pre>` });
}
