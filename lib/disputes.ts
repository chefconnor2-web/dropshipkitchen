// Card disputes (chargebacks), handled without the owner having to do anything:
// - Each dispute is recorded (from the Stripe webhook, and a sync every 15 minutes in case a webhook is missed),
//   the owners get one email, and the customer, email and card are blocked from booking again (lib/risk.ts).
// - While the trip can still be cancelled, the owner has 24 hours to tap "Cancel booking and accept" on
//   /admin/disputes: the airline or hotel refund comes back to us and the dispute is closed. The customer's money
//   already went back through their bank, so they aren't refunded again.
// - Otherwise Chit sends Stripe the evidence by itself (booking, confirmation code, travellers, the refund terms
//   shown above Pay, 3-D Secure, the account's activity): at once when the trip can't be cancelled, after 24 hours,
//   or sooner if Stripe's deadline is near. Product orders and plans are flagged for the owner instead.

import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { stripe } from "@/lib/stripe";
import { processSingleton } from "@/lib/singleton";
import { ownerAlert } from "@/lib/owner-alert";
import { flightTerms, hotelTerms, refundPolicyUrl } from "@/lib/refund-terms";
import { flightPrice, stayPrice, type FlightCard, type HotelCard } from "@/lib/flights-shared";

const OPEN = new Set(["warning_needs_response", "needs_response"]);
const GRACE_MS = 24 * 3600_000;
const DEADLINE_MS = 48 * 3600_000;

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");

type Flight = Awaited<ReturnType<typeof prisma.flightBooking.findFirst>>;
type Hotel = Awaited<ReturnType<typeof prisma.hotelBooking.findFirst>>;

async function bookingFor(paymentIntent: string | null): Promise<{ flight?: NonNullable<Flight>; hotel?: NonNullable<Hotel>; order?: { number: string; customerId: string | null; email: string | null } }> {
  if (!paymentIntent) return {};
  const flight = await prisma.flightBooking.findFirst({ where: { OR: [{ stripePaymentIntent: paymentIntent }, { stripeSessionId: paymentIntent }] } });
  if (flight) return { flight };
  const hotel = await prisma.hotelBooking.findFirst({ where: { OR: [{ stripePaymentIntent: paymentIntent }, { stripeSessionId: paymentIntent }] } });
  if (hotel) return { hotel };
  const order = await prisma.order.findFirst({ where: { stripePaymentIntent: paymentIntent }, select: { number: true, customerId: true, email: true } });
  return order ? { order } : {};
}

/** Whether the owner can still cancel the trip behind a dispute. */
export function tripCancellable(b: { flight?: NonNullable<Flight>; hotel?: NonNullable<Hotel> }, now = new Date()): boolean {
  if (b.flight) {
    const first = (JSON.parse(b.flight.cardJson) as FlightCard).slices[0]?.depart;
    return b.flight.status === "BOOKED" && !!b.flight.duffelOrderId && !!first && Date.parse(`${first.slice(0, 16)}:00Z`) > now.getTime() + 3 * 3600_000;
  }
  if (b.hotel) return b.hotel.status === "BOOKED" && !!b.hotel.liteBookingId && (JSON.parse(b.hotel.cardJson) as HotelCard).checkin > now.toISOString().slice(0, 10);
  return false;
}

/** Records (or updates) a dispute from Stripe; the first time, emails the owners. */
export async function recordDispute(d: Stripe.Dispute): Promise<void> {
  const chargeId = idOf(d.charge)!;
  const paymentIntent = idOf(d.payment_intent);
  const existing = await prisma.dispute.findUnique({ where: { id: d.id } });
  const base = { status: d.status, reason: d.reason, dueBy: d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000) : null };
  if (existing) {
    await prisma.dispute.update({ where: { id: d.id }, data: base });
    if (existing.status !== d.status && (d.status === "won" || d.status === "lost")) await ownerAlert("dispute_closed", `Dispute ${d.status}: ${existing.bookingNumber ?? d.id}`, `The bank decided the dispute on ${existing.bookingNumber ?? chargeId}: you ${d.status} (${(existing.amountCents / 100).toFixed(2)} ${existing.currency.toUpperCase()}).\n\n${config.siteUrl}/admin/disputes`);
    return;
  }
  const b = await bookingFor(paymentIntent);
  let fingerprint: string | null = null;
  let threeDs = false;
  try {
    const ch = await stripe().charges.retrieve(chargeId);
    fingerprint = ch.payment_method_details?.card?.fingerprint ?? null;
    const r = ch.payment_method_details?.card?.three_d_secure?.result;
    threeDs = r === "authenticated" || r === "attempt_acknowledged";
  } catch {
    // The dispute is still recorded and handled; only the card block and the 3-D Secure note are missing.
  }
  const row = await prisma.dispute.create({
    data: {
      id: d.id,
      chargeId,
      paymentIntent,
      amountCents: d.amount,
      currency: d.currency,
      kind: b.flight ? "flight" : b.hotel ? "hotel" : b.order ? "order" : "other",
      bookingNumber: b.flight?.number ?? b.hotel?.number ?? b.order?.number ?? null,
      customerId: b.flight?.customerId ?? b.hotel?.customerId ?? b.order?.customerId ?? null,
      email: (b.flight?.email ?? b.hotel?.email ?? b.order?.email ?? null)?.toLowerCase() ?? null,
      cardFingerprint: fingerprint,
      threeDs,
      ...base,
    },
  });
  const cancellable = tripCancellable(b);
  const money = `${(d.amount / 100).toFixed(2)} ${d.currency.toUpperCase()}`;
  const next = !b.flight && !b.hotel
    ? "This isn't a flight or hotel, so respond to it yourself in Stripe (Payments → Disputes)."
    : cancellable
      ? "The trip hasn't happened yet. If you'd rather cancel it (the airline or hotel refund comes back to you and the dispute is accepted), tap \"Cancel booking and accept\" within 24 hours. Otherwise Chit sends Stripe the evidence by itself."
      : "The trip can't be cancelled any more, so Chit is sending Stripe the evidence now. Nothing for you to do.";
  await ownerAlert(
    "dispute_new",
    `Dispute: ${row.bookingNumber ?? chargeId} (${money}, ${d.reason.replace(/_/g, " ")})`,
    `A customer disputed a payment with their bank.\n\n${row.kind === "other" ? "Payment" : `${row.kind[0].toUpperCase()}${row.kind.slice(1)} booking`}: ${row.bookingNumber ?? chargeId}\nAmount: ${money}\nReason: ${d.reason.replace(/_/g, " ")}\nCustomer: ${row.email ?? "unknown"}\n3-D Secure: ${threeDs ? "yes (a fraud claim is the bank's loss, not yours)" : "no"}\nRespond by: ${day(base.dueBy)}\n\n${next}\n\nThe customer, email and card can't book again.\n\n${config.siteUrl}/admin/disputes`,
  );
  await prisma.dispute.update({ where: { id: d.id }, data: { alertedAt: new Date() } });
}

/** The evidence Stripe receives for a flight or hotel dispute, built from what Chit recorded. */
export function buildEvidence(input: {
  flight?: NonNullable<Flight>;
  hotel?: NonNullable<Hotel>;
  threeDs: boolean;
  activity: string[];
}): Stripe.DisputeUpdateParams.Evidence {
  const policy = refundPolicyUrl();
  if (input.flight) {
    const b = input.flight;
    const card = JSON.parse(b.cardJson) as FlightCard;
    const names = (JSON.parse(b.passengersJson) as Array<{ given_name: string; family_name: string }>).map((p) => `${p.given_name} ${p.family_name}`);
    const first = card.slices[0];
    const route = card.slices.map((s) => `${s.from} → ${s.to} ${s.depart.slice(0, 16).replace("T", " ")}`).join("; ");
    const terms = flightTerms(card);
    return {
      product_description: `Airline ticket(s) on ${card.airline}: ${route}. Passengers: ${names.join(", ")}. Airline confirmation (PNR) ${b.bookingReference ?? "pending"}; ticket issued ${day(b.bookedAt)}. Booking ${b.number}, paid ${flightPrice({ priceCents: b.priceCents, currency: b.currency })} on ${day(b.paidAt)}.`,
      customer_name: names[0] ?? undefined,
      customer_email_address: b.email,
      service_date: first?.depart.slice(0, 10),
      refund_policy_disclosure: `The refund terms were shown before payment, in the booking card, on the checkout page directly above the Pay button, and again in the confirmation email: "${terms}" Our public refund policy: ${policy}`,
      cancellation_policy_disclosure: `Cancellation was available online from the trip page, with the airline's refund shown before confirming. Terms shown before payment: "${terms}" Policy: ${policy}`,
      refund_refusal_explanation: b.cancelledAt
        ? `The customer cancelled on ${day(b.cancelledAt)} and was refunded ${flightPrice({ priceCents: b.refundCents ?? 0, currency: b.currency })}, what the airline refunded under the fare rules.`
        : "No cancellation or refund was requested before this dispute, though cancellation was available online from the trip page. The ticket was issued and the booking was not cancelled.",
      access_activity_log: input.activity.join("\n").slice(0, 19_000) || undefined,
      uncategorized_text: [
        `The ticket was issued by ${card.airline} under confirmation ${b.bookingReference ?? "(see above)"} for the passengers named above, booked from the customer's signed-in account (${b.email}).`,
        input.threeDs ? "The payment was authenticated with 3-D Secure by the cardholder's bank." : "",
        `A confirmation email with the airline confirmation code and refund terms was sent to ${b.email} when the ticket was issued.`,
      ].filter(Boolean).join(" "),
    };
  }
  const b = input.hotel!;
  const card = JSON.parse(b.cardJson) as HotelCard;
  const terms = hotelTerms(card);
  return {
    product_description: `Hotel stay at ${card.name}${card.address ? `, ${card.address}` : ""}: ${card.checkin} to ${card.checkout} (${card.nights} night${card.nights === 1 ? "" : "s"}), ${card.room}. Lead guest ${b.firstName} ${b.lastName}. Hotel confirmation ${b.confirmationCode ?? "pending"}; booked ${day(b.bookedAt)}. Booking ${b.number}, paid ${stayPrice({ priceCents: b.priceCents, currency: b.currency })} on ${day(b.paidAt)}.`,
    customer_name: `${b.firstName} ${b.lastName}`,
    customer_email_address: b.email,
    service_date: card.checkin,
    refund_policy_disclosure: `The refund terms were shown before payment, in the booking card, on the checkout page directly above the Pay button, and again in the confirmation email: "${terms}" Our public refund policy: ${policy}`,
    cancellation_policy_disclosure: `Cancellation was available online from the booking page within the hotel's terms. Terms shown before payment: "${terms}" Policy: ${policy}`,
    refund_refusal_explanation: b.cancelledAt
      ? `The guest cancelled on ${day(b.cancelledAt)} and was refunded ${stayPrice({ priceCents: b.refundCents ?? 0, currency: b.currency })}, what the hotel refunded under its policy.`
      : "No cancellation or refund was requested before this dispute, though cancellation was available online within the hotel's terms. The room was booked and not cancelled.",
    access_activity_log: input.activity.join("\n").slice(0, 19_000) || undefined,
    uncategorized_text: [
      `The stay was confirmed by the hotel under confirmation ${b.confirmationCode ?? "(see above)"} for the guest named above, booked from the customer's signed-in account (${b.email}).`,
      input.threeDs ? "The payment was authenticated with 3-D Secure by the cardholder's bank." : "",
      `A confirmation email with the hotel confirmation and refund terms was sent to ${b.email}.`,
    ].filter(Boolean).join(" "),
  };
}

/** What the customer's account did around the booking (connected-app calls), for the evidence. */
async function activityLog(customerId: string | null, around: Date): Promise<string[]> {
  if (!customerId) return [];
  const calls = await prisma.mcpCall.findMany({ where: { customerId, createdAt: { gte: new Date(around.getTime() - 3 * 86400_000), lte: new Date(around.getTime() + 86400_000) } }, orderBy: { createdAt: "asc" }, take: 200 });
  return calls.map((c) => `${day(c.createdAt)} ${c.tool}${c.ok ? "" : " (failed)"}`);
}

/** Sends Stripe the evidence for one dispute (flights and hotels only). */
export async function submitEvidence(disputeId: string): Promise<{ ok: true } | { error: string }> {
  const row = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!row) return { error: "Unknown dispute." };
  if (row.evidenceSubmitted || row.cancelledAt) return { error: "Already handled." };
  const b = await bookingFor(row.paymentIntent);
  if (!b.flight && !b.hotel) return { error: "Not a flight or hotel: respond in Stripe." };
  const booking = (b.flight ?? b.hotel)!;
  const evidence = buildEvidence({ ...b, threeDs: row.threeDs, activity: [`${day(booking.createdAt)} booking ${booking.number} started`, ...(await activityLog(booking.customerId, booking.createdAt)), booking.paidAt ? `${day(booking.paidAt)} paid` : "", booking.bookedAt ? `${day(booking.bookedAt)} ${b.flight ? "ticket issued" : "hotel confirmed"}` : ""].filter(Boolean) });
  try {
    await stripe().disputes.update(disputeId, { evidence, submit: true });
  } catch (e) {
    await ownerAlert("dispute_evidence_failed", `Couldn't send evidence for ${row.bookingNumber}`, `Stripe refused the evidence for dispute ${disputeId} (${e instanceof Error ? e.message : e}). Respond in Stripe (Payments → Disputes) before ${day(row.dueBy)}.\n\n${config.siteUrl}/admin/disputes`);
    return { error: e instanceof Error ? e.message : String(e) };
  }
  await prisma.dispute.update({ where: { id: disputeId }, data: { evidenceSubmitted: new Date() } });
  return { ok: true };
}

/** The owner's "Cancel booking and accept": cancel the trip (no customer refund), then accept the dispute. */
export async function cancelForDispute(disputeId: string): Promise<{ ok: true; recoveredCents: number } | { error: string }> {
  const row = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!row || !OPEN.has(row.status) || row.evidenceSubmitted || row.cancelledAt) return { error: "This dispute can't be cancelled from here any more." };
  const b = await bookingFor(row.paymentIntent);
  if (!tripCancellable(b)) return { error: "The trip can't be cancelled any more." };
  let recovered = 0;
  if (b.flight) {
    const { quoteFlightCancel, confirmFlightCancel } = await import("@/lib/flight-booking");
    const q = await quoteFlightCancel(b.flight.id);
    if ("error" in q) return q;
    const r = await confirmFlightCancel(b.flight.id, q.quoteId, { disputed: true });
    if ("error" in r) return r;
    recovered = q.refundCents;
  } else if (b.hotel) {
    const { cancelStay } = await import("@/lib/hotel-booking");
    const r = await cancelStay(b.hotel.id, { disputed: true });
    if ("error" in r) return r;
  }
  await prisma.dispute.update({ where: { id: disputeId }, data: { cancelledAt: new Date() } });
  try {
    await stripe().disputes.close(disputeId);
  } catch (e) {
    await ownerAlert("dispute_close_failed", `Accept dispute ${disputeId} in Stripe`, `The booking ${row.bookingNumber} was cancelled, but accepting the dispute in Stripe failed (${e instanceof Error ? e.message : e}). Accept it in Stripe (Payments → Disputes).`);
  }
  return { ok: true, recoveredCents: recovered };
}

/** Sends evidence for every open flight or hotel dispute whose owner window has passed (or can't be used). */
export async function processDisputes(now = new Date()): Promise<void> {
  const open = await prisma.dispute.findMany({ where: { status: { in: [...OPEN] }, evidenceSubmitted: null, cancelledAt: null, kind: { in: ["flight", "hotel"] } } });
  for (const row of open) {
    const b = await bookingFor(row.paymentIntent);
    const due = row.dueBy && row.dueBy.getTime() - now.getTime() < DEADLINE_MS;
    if (!tripCancellable(b, now) || now.getTime() - row.createdAt.getTime() >= GRACE_MS || due) await submitEvidence(row.id).catch((e) => console.error("[disputes] evidence:", e));
  }
}

/** Pulls recent disputes from Stripe (in case a webhook was missed), then sends evidence where it's time. */
export async function syncDisputes(): Promise<void> {
  const since = Math.floor(Date.now() / 1000) - 120 * 86400;
  for await (const d of stripe().disputes.list({ limit: 100, created: { gte: since } })) await recordDispute(d).catch((e) => console.error("[disputes] record:", e));
  await processDisputes();
}

const EVERY_MS = 15 * 60_000;

/** Started once per server process (instrumentation.ts). */
export function startDisputeScheduler() {
  if (!process.env.STRIPE_SECRET_KEY?.trim()) return;
  const state = processSingleton("dispute-scheduler", () => ({ timer: null as ReturnType<typeof setInterval> | null }));
  if (state.timer) return;
  const tick = () => void syncDisputes().catch((e) => console.error("[disputes] sync failed:", e instanceof Error ? e.message : e));
  state.timer = setInterval(tick, EVERY_MS);
  setTimeout(tick, 60_000);
}
