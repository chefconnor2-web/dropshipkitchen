import Link from "next/link";
import { getOffer, DuffelError, duffelConfigured, duffelTestMode, type DuffelOffer } from "@/lib/duffel";
import { toCard } from "@/lib/flights";
import { passengerSlots } from "@/lib/flight-booking";
import { FlightCard } from "@/components/chat/ui";
import BookForm from "./BookForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book your flight", robots: { index: false } };

export default async function BookFlightPage({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
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
          <Link href="/">← Ask the assistant to search again for current fares</Link>
        </p>
      </div>
    );

  const card = toCard(offer);
  const slots = passengerSlots(offer);
  return (
    <div className="wrap page narrow fl-book">
      <p className="eyebrow">{duffelTestMode() ? "Test mode · no real ticket is issued" : "Secure booking"}</p>
      <h1 className="page-title">Book your flight</h1>
      <div className="fl-summary">
        <FlightCard f={card} bookable={false} />
        <p className="muted small">
          {card.refundable === true ? "Refundable fare. " : card.refundable === false ? "Non-refundable fare. " : ""}
          {card.changeable === true ? "Changes allowed (the airline may charge a fee)." : card.changeable === false ? "No changes allowed." : ""}
        </p>
      </div>
      <BookForm offerId={offer.id} priceCents={card.priceCents} currency={card.currency} slots={slots} needPassport={offer.passenger_identity_documents_required === true} />
    </div>
  );
}
