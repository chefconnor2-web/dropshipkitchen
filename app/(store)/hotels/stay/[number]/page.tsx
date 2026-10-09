import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { getMemberId } from "@/lib/session";
import { completeHotelBooking, HOTEL_STATUS, stayToken } from "@/lib/hotel-booking";
import { HotelCard } from "@/components/chat/ui";
import { stayPrice, uberLink, type HotelCard as Card } from "@/lib/flights-shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your stay", robots: { index: false } };

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default async function StayPage({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ s?: string; t?: string }> }) {
  const { number } = await params;
  const { s, t } = await searchParams;
  const b = await prisma.hotelBooking.findUnique({ where: { number } });
  if (!b) notFound();
  // Back from Stripe (s), the emailed link (t), or signed in as its owner.
  const member = await getMemberId();
  const allowed = (!!s && !!b.stripeSessionId && same(s, b.stripeSessionId)) || (!!t && same(t, await stayToken(b.id))) || (!!member && b.customerId === member);
  if (!allowed) notFound();

  let status = b.status;
  if (status === HOTEL_STATUS.PENDING_PAYMENT && s) {
    const session = await stripe().checkout.sessions.retrieve(s).catch(() => null);
    if (session?.payment_status === "paid") {
      after(() => completeHotelBooking(session).catch((e) => console.error("[hotels] booking failed:", e)));
      status = HOTEL_STATUS.BOOKING;
    }
  }
  const card = JSON.parse(b.cardJson) as Card;
  const price = stayPrice({ priceCents: b.priceCents, currency: b.currency });
  const working = status === HOTEL_STATUS.BOOKING;
  const head =
    status === HOTEL_STATUS.BOOKED
      ? { title: "You're booked", sub: `Show confirmation ${b.confirmationCode} and your ID at the front desk. We've emailed the details to ${b.email}.`, tone: "is-done" }
      : working
        ? { title: "Booking your room…", sub: "Payment received. We're confirming with the hotel; this usually takes a few seconds.", tone: "" }
        : status === HOTEL_STATUS.FAILED_REFUNDED
          ? { title: "Not booked, refunded", sub: `${b.error ?? "The hotel couldn't confirm this booking."} Your payment of ${price} was refunded in full.`, tone: "is-off" }
          : status === HOTEL_STATUS.NEEDS_REVIEW
            ? { title: "We're checking with the hotel", sub: "Your payment went through but the hotel was slow to confirm. We'll email you shortly with your confirmation or a full refund.", tone: "is-warn" }
            : { title: "Payment not completed", sub: "Your card wasn't charged. Go back to book again, or ask the assistant for current rates.", tone: "is-off" };
  return (
    <div className="wrap page narrow trk">
      {working && <meta httpEquiv="refresh" content="3" />}
      <p className="eyebrow">Stay {b.number}</p>
      <h1 className="page-title">{card.name}</h1>
      <section className={`trk-hero ${head.tone}`} aria-live="polite">
        <div className="trk-headline">{head.title}</div>
        <p className="trk-sub">{head.sub}</p>
        {status === HOTEL_STATUS.BOOKED && b.confirmationCode && (
          <p className="fl-pnr">
            <span>Confirmation</span>
            <code>{b.confirmationCode}</code>
          </p>
        )}
      </section>
      <div className="fl-summary">
        <HotelCard h={card} bookable={false} />
      </div>
      {status === HOTEL_STATUS.BOOKED && (
        <p>
          <a className="btn" href={uberLink({ name: card.name, address: card.address || card.city, latitude: card.latitude, longitude: card.longitude })} target="_blank" rel="noopener noreferrer">
            Get an Uber to the hotel
          </a>
        </p>
      )}
      <dl className="fl-facts">
        <dt>Lead guest</dt>
        <dd>
          {b.firstName} {b.lastName}
        </dd>
        <dt>Dates</dt>
        <dd>
          {card.checkin} to {card.checkout} ({card.nights} night{card.nights === 1 ? "" : "s"})
        </dd>
        <dt>Paid</dt>
        <dd>{status === HOTEL_STATUS.PENDING_PAYMENT ? "Not charged" : status === HOTEL_STATUS.FAILED_REFUNDED ? `${price}, refunded` : price}</dd>
        <dt>Confirmation email</dt>
        <dd>{b.email}</dd>
      </dl>
      <p>
        <Link href="/">← Back to the assistant</Link>
      </p>
    </div>
  );
}
