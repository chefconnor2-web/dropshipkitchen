// A shared trip: "Connor is flying to Toronto, come along". Friends see the flights, who's going (first names
// only) and today's price for the same flights for their own group, then book with one tap.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { duffelTestMode } from "@/lib/duffel";
import { departed, tripDates, tripTitle, whosGoing } from "@/lib/shared-trips";
import type { FlightCard as Card } from "@/lib/flights-shared";
import { FlightCard } from "@/components/chat/ui";
import ShareButton from "@/components/ShareButton";
import JoinTrip from "./JoinTrip";

export const dynamic = "force-dynamic";

async function load(slug: string) {
  const trip = await prisma.sharedTrip.findUnique({ where: { slug } });
  return trip ? { trip, card: JSON.parse(trip.cardJson) as Card } : null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const t = await load((await params).slug);
  if (!t) return {};
  const title = tripTitle(t.card, t.trip.hostName);
  const description = `${tripDates(t.card)} · ${t.card.airline} · Book the same flights in a tap on ${config.storeName}.`;
  const images = [{ url: `/trips/${t.trip.slug}/card`, width: 1200, height: 630, alt: title }];
  return {
    title: `${title} · ${config.storeName}`,
    description,
    robots: { index: false },
    openGraph: { title, description, url: `/trips/${t.trip.slug}`, siteName: config.storeName, type: "website", images },
    twitter: { card: "summary_large_image", title, description, images: images.map((i) => i.url) },
  };
}

export default async function SharedTripPage({ params }: { params: Promise<{ slug: string }> }) {
  const t = await load((await params).slug);
  if (!t) notFound();
  const { trip, card } = t;
  await prisma.sharedTrip.update({ where: { id: trip.id }, data: { views: { increment: 1 } } }).catch(() => {});
  const going = await whosGoing(trip);
  const gone = departed(card);
  const title = tripTitle(card, trip.hostName);
  return (
    <div className="wrap page narrow trip-share">
      <p className="eyebrow">{duffelTestMode() ? "Test mode · no real ticket is issued" : "Trip with friends"}</p>
      <h1 className="page-title">{title}</h1>
      <p className="trip-sub">
        {tripDates(card)} · {card.airline}. Book a seat on the same flights and travel together. Everyone pays for their own ticket.
      </p>
      {going.length > 0 && (
        <div className="trip-going" aria-label="Who's going">
          <span className="trip-going-faces" aria-hidden>
            {going.slice(0, 5).map((n, i) => (
              <span key={i}>{n.charAt(0)}</span>
            ))}
          </span>
          <span>
            <strong>{going.length === 1 ? `${going[0]} is going` : `${going.slice(0, -1).join(", ")} and ${going[going.length - 1]} are going`}</strong>
          </span>
        </div>
      )}
      <div className="fl-summary">
        <FlightCard f={card} bookable={false} hidePrice />
      </div>
      {gone ? (
        <p className="notice">This trip has already left. Ask {config.storeName} to find flights for your own trip.</p>
      ) : (
        <JoinTrip slug={trip.slug} />
      )}
      <div className="trip-actions">
        <ShareButton url={`/trips/${trip.slug}`} text={`${title} · ${tripDates(card)}`} label="Invite more friends" />
        <Link href="/" className="trip-ask">
          Plan your own trip with {config.storeName} →
        </Link>
      </div>
    </div>
  );
}
