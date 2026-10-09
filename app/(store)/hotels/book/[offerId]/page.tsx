import Link from "next/link";
import { liteapiConfigured, liteapiTestMode } from "@/lib/liteapi";
import { offerCard } from "@/lib/hotels";
import { HotelCard } from "@/components/chat/ui";
import BookForm from "./BookForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book your hotel", robots: { index: false } };

export default async function BookHotelPage({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const card = liteapiConfigured() && offerId.length <= 400 ? await offerCard(decodeURIComponent(offerId)) : null;
  const stale = card && card.checkin < new Date().toISOString().slice(0, 10);
  if (!card || stale)
    return (
      <div className="wrap page narrow">
        <h1 className="page-title">Book your hotel</h1>
        <p className="notice err">{!liteapiConfigured() ? "Hotels aren't available right now." : stale ? "These dates have passed." : "We couldn't find this room any more."}</p>
        <p>
          <Link href="/">← Ask the assistant to search again for current rates</Link>
        </p>
      </div>
    );
  const guests = card.adults + card.childAges.length;
  return (
    <div className="wrap page narrow fl-book">
      <p className="eyebrow">{liteapiTestMode() ? "Test mode · no real room is booked" : "Secure booking"}</p>
      <h1 className="page-title">Book your hotel</h1>
      <div className="fl-summary">
        <HotelCard h={card} bookable={false} />
        <p className="muted small">
          {guests} guest{guests > 1 ? "s" : ""} · check-in {card.checkin} · check-out {card.checkout}. {card.refundable === false ? "This rate is non-refundable." : card.refundable ? "Free cancellation on this rate (see the hotel's policy in your confirmation)." : ""}
        </p>
      </div>
      <BookForm offerId={card.id} priceCents={card.priceCents} currency={card.currency} />
    </div>
  );
}
