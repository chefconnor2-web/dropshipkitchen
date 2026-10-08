// Trips with friends: someone shares the flights they found or booked, friends open the link, and each books a
// seat on the same flights, paying for themselves. Airline prices only live about 20 minutes, so a share
// keeps the flights themselves (airline, flight numbers, times) and every friend gets a live search for those
// exact flights at today's price. If they're gone or full, the closest flights that day are offered instead.
// Nobody's passenger details are ever shown on a shared trip, only the first names of who's going.

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { getOffer } from "@/lib/duffel";
import { rank, searchFlights, toCard, type FlightSearch } from "@/lib/flights";
import { FLIGHT_STATUS, type PassengerInput } from "@/lib/flight-booking";
import { shortDate, type FlightCard } from "@/lib/flights-shared";

export type Cabin = FlightSearch["cabin"];

/** The flights themselves, ignoring price: "AC123@2026-11-03T08:05>AC456@…|…" (one part per slice). */
export function flightKey(c: Pick<FlightCard, "slices">): string {
  return c.slices.map((s) => s.segments.map((g) => `${g.flight}@${g.depart.slice(0, 16)}`).join(">")).join("|");
}

/** The search cabin from the card's marketing name ("Premium Economy", "Business Saver"…). */
export function cabinOf(c: Pick<FlightCard, "cabin">): Cabin {
  const n = c.cabin.toLowerCase();
  return n.includes("first") ? "first" : n.includes("business") ? "business" : n.includes("premium") ? "premium_economy" : "economy";
}

/** The search that finds these flights again, for however many travellers are joining. */
export function tripSearch(card: FlightCard, cabin: Cabin, adults: number, childAges: number[]): FlightSearch {
  return {
    label: "Join",
    slices: card.slices.map((s) => ({ origin: s.from, destination: s.to, date: s.depart.slice(0, 10) })),
    adults: Math.min(9, Math.max(1, adults)),
    childAges: childAges.slice(0, 8),
    cabin,
    maxStops: null,
    departAfter: "",
    departBefore: "",
    checkedBag: false,
  };
}

const minutes = (iso: string) => Date.parse(`${iso.slice(0, 16)}:00Z`) / 60_000;

/** Today's offers split into the exact flights that were shared and, failing that, the closest ones that day. */
export function matchTrip(shared: FlightCard, offers: FlightCard[]): { exact: FlightCard[]; similar: FlightCard[] } {
  const key = flightKey(shared);
  const exact = offers.filter((o) => flightKey(o) === key).sort((a, b) => a.priceCents - b.priceCents);
  if (exact.length) return { exact: exact.slice(0, 2), similar: [] };
  // Closest departures per slice; an hour off weighs about the same as 5% on the price.
  const gap = (o: FlightCard) => o.slices.reduce((n, s, i) => n + Math.abs(minutes(s.depart) - minutes(shared.slices[i]?.depart ?? s.depart)), 0);
  const sameAirline = offers.filter((o) => o.airline === shared.airline);
  const pool = sameAirline.length ? sameAirline : offers;
  const minP = Math.min(...pool.map((o) => o.priceCents));
  const close = [...pool].sort((a, b) => gap(a) / 60 / 20 + a.priceCents / minP - (gap(b) / 60 / 20 + b.priceCents / minP));
  const out = close.slice(0, 2);
  // Also the best value that day when it's a different flight.
  const best = rank(offers, 1)[0];
  if (best && !out.some((o) => o.id === best.id)) out.push(best);
  return { exact: [], similar: out };
}

/** True once the first flight has left (local date at the airport, compared generously). */
export function departed(card: FlightCard, now = new Date()): boolean {
  const first = card.slices[0]?.depart;
  return !!first && first.slice(0, 10) < new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
}

// ---------- links ----------

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newSlug(): string {
  const bytes = randomBytes(10);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Strips the card to what friends may see: the flights, without the price the sharer paid. */
function publicCard(c: FlightCard): FlightCard {
  return { ...c, id: "", priceCents: 0, group: undefined };
}

export function sharedTripUrl(slug: string): string {
  return `${config.siteUrl}/trips/${slug}`;
}

/** A link for flights found in the chat (the offer must still be live, so what's shared is real). */
export async function shareFromOffer(offerId: string): Promise<string> {
  const offer = await getOffer(offerId);
  const card = toCard(offer);
  const trip = await prisma.sharedTrip.create({ data: { slug: newSlug(), cardJson: JSON.stringify(publicCard(card)), cabin: cabinOf(card) } });
  return trip.slug;
}

/** The link for a booked trip ("join me"): one per booking, made the first time it's asked for. */
export async function shareFromBooking(bookingId: string): Promise<string | null> {
  const b = await prisma.flightBooking.findUnique({ where: { id: bookingId } });
  if (!b || b.status !== FLIGHT_STATUS.BOOKED) return null;
  const existing = await prisma.sharedTrip.findUnique({ where: { hostBookingId: b.id } });
  if (existing) return existing.slug;
  // Someone who joined a friend's trip shares that same trip, so everyone ends up on one list.
  if (b.sharedTripId) {
    const joined = await prisma.sharedTrip.findUnique({ where: { id: b.sharedTripId } });
    if (joined) return joined.slug;
  }
  const card = JSON.parse(b.cardJson) as FlightCard;
  const host = (JSON.parse(b.passengersJson) as PassengerInput[])[0]?.given_name ?? null;
  const trip = await prisma.sharedTrip
    .create({ data: { slug: newSlug(), cardJson: JSON.stringify(publicCard(card)), cabin: cabinOf(card), hostName: host ? firstName(host) : null, hostBookingId: b.id } })
    .catch(async () => prisma.sharedTrip.findUniqueOrThrow({ where: { hostBookingId: b.id } })); // two tabs at once
  return trip.slug;
}

const firstName = (given: string) => {
  const w = given.trim().split(/\s+/)[0] ?? "";
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
};

/** First names of everyone booked on the trip (the host first), without repeats. */
export async function whosGoing(trip: { id: string; hostBookingId: string | null }): Promise<string[]> {
  const bookings = await prisma.flightBooking.findMany({
    where: { status: FLIGHT_STATUS.BOOKED, OR: [{ sharedTripId: trip.id }, ...(trip.hostBookingId ? [{ id: trip.hostBookingId }] : [])] },
    orderBy: { bookedAt: "asc" },
    select: { id: true, passengersJson: true },
  });
  bookings.sort((a, b) => Number(b.id === trip.hostBookingId) - Number(a.id === trip.hostBookingId));
  const names: string[] = [];
  for (const b of bookings) for (const p of JSON.parse(b.passengersJson) as PassengerInput[]) names.push(firstName(p.given_name));
  return names;
}

/** Live offers for a friend joining: the same flights if they're still for sale, else the closest. */
export async function joinOffers(trip: { cardJson: string; cabin: string }, adults: number, childAges: number[]) {
  const card = JSON.parse(trip.cardJson) as FlightCard;
  const offers = await searchFlights(tripSearch(card, trip.cabin as Cabin, adults, childAges));
  return matchTrip(card, offers);
}

/** "Toronto" for a one-way or return trip; "Toronto + 2 more" for multi-city. */
export function destinationLabel(c: FlightCard): string {
  const first = c.slices[0];
  if (!first) return "a trip";
  const back = c.slices.length === 2 && c.slices[1].to === first.from;
  return c.slices.length === 1 || back ? first.toCity : `${first.toCity} + ${c.slices.length - 1} more`;
}

/** "Join Connor's trip to Toronto", or "Fly together to Toronto" when shared from a search. */
export function tripTitle(card: FlightCard, host: string | null): string {
  return `${host ? `Join ${host}'s trip` : "Fly together"} to ${destinationLabel(card)}`;
}

/** "Nov 3" one-way, "Nov 3 – Nov 10" for a return or multi-city trip. */
export function tripDates(card: FlightCard): string {
  const first = card.slices[0];
  const last = card.slices[card.slices.length - 1];
  if (!first) return "";
  return card.slices.length > 1 ? `${shortDate(first.depart)} – ${shortDate(last.depart)}` : shortDate(first.depart);
}
