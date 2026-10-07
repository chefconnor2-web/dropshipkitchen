import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { getMemberId } from "@/lib/session";
import { completeFlightBooking, FLIGHT_STATUS, routeLabel, tripToken, type PassengerInput } from "@/lib/flight-booking";
import { FlightCard } from "@/components/chat/ui";
import { flightPrice, type FlightCard as Card } from "@/lib/flights-shared";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your trip", robots: { index: false } };

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default async function TripPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ s?: string; t?: string }> }) {
  const { number } = await params;
  const { s, t } = await searchParams;
  const b = await prisma.flightBooking.findUnique({ where: { number } });
  if (!b) notFound();
  // Three ways in, all specific to this booking: back from Stripe (s), the emailed link (t), or signed in as its owner.
  const member = await getMemberId();
  const allowed = (!!s && !!b.stripeSessionId && same(s, b.stripeSessionId)) || (!!t && same(t, await tripToken(b.id))) || (!!member && b.customerId === member);
  if (!allowed) notFound();

  // Straight back from Stripe: confirm the payment and book in the background (the webhook may beat us to it).
  let status = b.status;
  if (status === FLIGHT_STATUS.PENDING_PAYMENT && s) {
    const session = await stripe().checkout.sessions.retrieve(s).catch(() => null);
    if (session?.payment_status === "paid") {
      after(() => completeFlightBooking(session).catch((e) => console.error("[flights] booking failed:", e)));
      status = FLIGHT_STATUS.BOOKING;
    }
  }

  const card = JSON.parse(b.cardJson) as Card;
  const names = (JSON.parse(b.passengersJson) as PassengerInput[]).map((p) => `${p.given_name} ${p.family_name}`);
  const price = flightPrice({ priceCents: b.priceCents, currency: b.currency });
  const working = status === FLIGHT_STATUS.BOOKING;
  const head =
    status === FLIGHT_STATUS.BOOKED
      ? { title: "You're booked", sub: `Confirmation code ${b.bookingReference}. Use it to check in with ${card.airline}. We've emailed your e-ticket details to ${b.email}.`, tone: "is-done" }
      : working
        ? { title: "Booking your ticket…", sub: "Payment received. We're confirming your seat with the airline; this usually takes a few seconds.", tone: "" }
        : status === FLIGHT_STATUS.FAILED_REFUNDED
          ? { title: "Not booked, refunded", sub: `${b.error ?? "The airline couldn't confirm this booking."} Your payment of ${price} was refunded in full.`, tone: "is-off" }
          : status === FLIGHT_STATUS.NEEDS_REVIEW
            ? { title: "We're checking with the airline", sub: "Your payment went through but the airline was slow to confirm. We're on it and will email you shortly, either your confirmation or a full refund.", tone: "is-warn" }
            : { title: "Payment not completed", sub: "Your card wasn't charged. Go back to book again, or ask the assistant for current fares.", tone: "is-off" };

  return (
    <div className="wrap page narrow trk">
      {working && <meta httpEquiv="refresh" content="3" />}
      <p className="eyebrow">Trip {b.number}</p>
      <h1 className="page-title">{routeLabel(card)}</h1>
      <section className={`trk-hero ${head.tone}`} aria-live="polite">
        <div className="trk-headline">{head.title}</div>
        <p className="trk-sub">{head.sub}</p>
        {status === FLIGHT_STATUS.BOOKED && b.bookingReference && (
          <p className="fl-pnr">
            <span>Airline confirmation</span>
            <code>{b.bookingReference}</code>
          </p>
        )}
      </section>
      <div className="fl-summary">
        <FlightCard f={card} bookable={false} />
      </div>
      <dl className="fl-facts">
        <dt>Passengers</dt>
        <dd>{names.join(", ")}</dd>
        <dt>Paid</dt>
        <dd>{status === FLIGHT_STATUS.PENDING_PAYMENT ? "Not charged" : status === FLIGHT_STATUS.FAILED_REFUNDED ? `${price}, refunded` : price}</dd>
        <dt>E-ticket email</dt>
        <dd>{b.email}</dd>
      </dl>
      <p>
        <Link href="/">← Back to the assistant</Link>
      </p>
    </div>
  );
}
