import Link from "next/link";
import { getOffer, DuffelError, duffelConfigured, duffelTestMode, type DuffelOffer } from "@/lib/duffel";
import { toCard } from "@/lib/flights";
import { passengerSlots } from "@/lib/flight-booking";
import { FlightCard } from "@/components/chat/ui";
import BookForm from "./BookForm";
import { prisma } from "@/lib/db";
import { tripTitle } from "@/lib/shared-trips";
import type { FlightCard as Card } from "@/lib/flights-shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book your flight", robots: { index: false } };

export default async function BookFlightPage({ params, searchParams }: { params: Promise<{ offerId: string }>; searchParams: Promise<{ trip?: string }> }) {
  const { offerId } = await params;
  // Joining a friend's shared trip: say whose, and file the booking under it.
  const tripSlug = (await searchParams).trip;
  const trip = tripSlug ? await prisma.sharedTrip.findUnique({ where: { slug: tripSlug } }) : null;
  let offer: DuffelOffer | null = null;
  let problem: string | null = null;
  if (!duffelConfigured()) problem = "Flights aren't available right now.";
  else if (!/^off_[A-Za-z0-9]+$/.test(offerId)) problem = "This isn't a flight we can book.";
  else
    try {
      offer = await getOffer(offerId);
      if (Date.parse(offer.expires_at) < Date.now() + 60_000) problem = "This fare has expired.";
    } catch (e) {
      problem = e instanceof DuffelError && e.status === 404 ? "This fare is no longer available." : "We couldn't reach the airline just now. Refresh to try again.";
    }

  if (!offer || problem)
    return (
      <div className="wrap page narrow">
        <h1 className="page-title">Book your flight</h1>
        <p className="notice err">{problem}</p>
        <p>
          {trip ? <Link href={`/trips/${trip.slug}`}>← Back to the trip for today’s fares</Link> : <Link href="/">← Ask the assistant to search again for current fares</Link>}
        </p>
      </div>
    );

  const card = toCard(offer);
  const slots = passengerSlots(offer);
  return (
    <div className="wrap page narrow fl-book">
      <p className="eyebrow">{duffelTestMode() ? "Test mode · no real ticket is issued" : "Secure booking"}</p>
      <h1 className="page-title">Book your flight</h1>
      {trip && <p className="trip-joining">✈ {tripTitle(JSON.parse(trip.cardJson) as Card, trip.hostName)}</p>}
      <div className="fl-summary">
        <FlightCard f={card} bookable={false} />
        <p className="muted small">
          {card.refundable === true ? "Refundable fare. " : card.refundable === false ? "Non-refundable fare. " : ""}
          {card.changeable === true ? "Changes allowed (the airline may charge a fee)." : card.changeable === false ? "No changes allowed." : ""}
        </p>
      </div>
      <BookForm offerId={offer.id} priceCents={card.priceCents} currency={card.currency} slots={slots} needPassport={offer.passenger_identity_documents_required === true} tripSlug={trip?.slug} />
    </div>
  );
}
