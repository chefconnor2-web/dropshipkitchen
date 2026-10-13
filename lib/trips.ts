// Trips: what the shopper booked and arranged in each chat, gathered into one place: an itinerary (flights,
// hotel stays, packages on their way, emails sent) and the receipts and confirmations for it. A chat with at
// least one paid booking is a trip. Built on demand from the chats and bookings; nothing extra is stored.
// The Trips menu in the chat (components/chat/TripsPanel.tsx) and Neon's my_trips tool both read this.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { tripToken } from "@/lib/flight-booking";
import { stayToken } from "@/lib/hotel-booking";
import type { CarRentalCard, CartLinkCard, EmailDraftCard, FlightCard, HotelCard } from "@/lib/flights-shared";

export interface ItineraryItem {
  kind: "flight" | "checkin" | "checkout" | "car-pickup" | "car-dropoff" | "package" | "email";
  /** Local date-time "YYYY-MM-DDTHH:MM" or date "YYYY-MM-DD" at the place it happens; null when unknown. */
  when: string | null;
  title: string;
  detail: string;
}

export interface TripReceipt {
  kind: "flight" | "hotel" | "car" | "amazon" | "email";
  title: string;
  /** Our booking number (flights and hotels). */
  number?: string;
  /** The airline's or hotel's confirmation code. */
  confirmation?: string | null;
  status: string;
  /** "$412.30 CAD"; null when nothing was paid through us. */
  amount: string | null;
  refunded?: string | null;
  /** When it was paid or sent (ISO). */
  at: string | null;
  /** Where to see it in full: the booking page, the Amazon cart, or null. */
  href: string | null;
  lines?: string[];
}

export interface Trip {
  chatId: string;
  chatTitle: string;
  title: string;
  /** First and last dates of the trip (YYYY-MM-DD), when known. */
  start: string | null;
  end: string | null;
  /** upcoming | now | past */
  phase: "upcoming" | "now" | "past";
  cancelled: boolean;
  itinerary: ItineraryItem[];
  receipts: TripReceipt[];
}

const LIVE = ["BOOKED", "CANCELLING", "CANCELLED", "BOOKING", "NEEDS_REVIEW"];
const STATUS_LABEL: Record<string, string> = {
  BOOKED: "Confirmed",
  BOOKING: "Confirming…",
  CANCELLING: "Cancelling…",
  CANCELLED: "Cancelled",
  NEEDS_REVIEW: "Being checked",
};

export function money(cents: number, currency: string): string {
  try {
    return `${new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(cents / 100)} ${currency.toUpperCase()}`;
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);
const hm = (iso: string) => iso.slice(11, 16);
function niceDate(d: string): string {
  return new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

interface ChatRow {
  id: string;
  title: string;
  uiJson: string;
}
type FlightRow = {
  id: string;
  number: string;
  status: string;
  offerId: string;
  cardJson: string;
  priceCents: number;
  currency: string;
  passengersJson: string;
  bookingReference: string | null;
  refundCents: number | null;
  paidAt: Date | null;
  createdAt: Date;
};
type HotelRow = {
  id: string;
  number: string;
  status: string;
  offerId: string;
  cardJson: string;
  priceCents: number;
  currency: string;
  firstName: string;
  lastName: string;
  confirmationCode: string | null;
  refundCents: number | null;
  paidAt: Date | null;
  createdAt: Date;
};

/** What a chat showed: its flight and hotel card ids, the Amazon cart link and emails (latest version of each). */
export function chatShown(uiJson: string) {
  let ui: Array<{ role?: string; at?: string; items?: Array<Record<string, unknown>> }> = [];
  try {
    ui = JSON.parse(uiJson || "[]");
  } catch {}
  const flights = new Set<string>();
  const hotels = new Set<string>();
  let cart: CartLinkCard | null = null;
  const cars = new Map<string, CarRentalCard>();
  const emails = new Map<string, { card: EmailDraftCard; at: string | null }>();
  for (const e of Array.isArray(ui) ? ui : [])
    for (const it of Array.isArray(e?.items) ? e.items : []) {
      if (it.kind === "flight" && typeof it.id === "string") flights.add(it.id);
      else if (it.kind === "hotel") {
        if (typeof it.id === "string") hotels.add(it.id);
        if (typeof it.offerId === "string") hotels.add(it.offerId);
      } else if (it.kind === "car" && typeof it.id === "string") cars.set(it.id, it as unknown as CarRentalCard);
      else if (it.kind === "cart-link") cart = it as unknown as CartLinkCard;
      else if (it.kind === "email-draft" && typeof it.id === "string") emails.set(it.id, { card: it as unknown as EmailDraftCard, at: e.at ?? null });
    }
  return { flights, hotels, cars: [...cars.values()], cart: cart as CartLinkCard | null, emails: [...emails.values()] };
}

/** One trip from a chat and the bookings made from it (pure: links are passed in). */
export function buildTrip(
  chat: ChatRow,
  flights: Array<FlightRow & { href: string }>,
  hotels: Array<HotelRow & { href: string }>,
  today: string,
): Trip | null {
  const shown = chatShown(chat.uiJson);
  if (!flights.length && !hotels.length) return null;
  const itinerary: ItineraryItem[] = [];
  const receipts: TripReceipt[] = [];
  const dates: string[] = [];
  let destination: string | null = null;

  for (const b of flights) {
    const card = JSON.parse(b.cardJson) as FlightCard;
    const off = b.status === "CANCELLED";
    for (const s of card.slices) {
      const nums = s.segments.map((g) => `${g.carrier} ${g.flight}`).join(", ");
      if (!off) {
        itinerary.push({
          kind: "flight",
          when: s.depart.slice(0, 16),
          title: `Flight ${s.from} → ${s.to}`,
          detail: `${card.airline} ${nums} · departs ${hm(s.depart)}, arrives ${hm(s.arrive)}${day(s.arrive) !== day(s.depart) ? ` (${niceDate(s.arrive)})` : ""} · ${s.fromCity} to ${s.toCity}`,
        });
        dates.push(day(s.depart)!, day(s.arrive)!);
      }
    }
    destination ??= card.slices[0]?.toCity ?? null;
    const names = (JSON.parse(b.passengersJson) as Array<{ given_name?: string; family_name?: string }>).map((p) => `${p.given_name ?? ""} ${p.family_name ?? ""}`.trim());
    receipts.push({
      kind: "flight",
      title: `${card.airline}: ${card.slices.map((s) => `${s.from} → ${s.to}`).join(", ")}`,
      number: b.number,
      confirmation: b.bookingReference,
      status: STATUS_LABEL[b.status] ?? b.status,
      amount: money(b.priceCents, b.currency),
      refunded: b.refundCents ? money(b.refundCents, b.currency) : null,
      at: (b.paidAt ?? b.createdAt).toISOString(),
      href: b.href,
      lines: [names.length ? `Passengers: ${names.join(", ")}` : "", card.cabin ? `Cabin: ${card.cabin.replace(/_/g, " ")}` : ""].filter(Boolean),
    });
  }

  for (const b of hotels) {
    const card = JSON.parse(b.cardJson) as HotelCard;
    const off = b.status === "CANCELLED";
    const where = [card.address, card.city].filter(Boolean).join(", ");
    if (!off) {
      itinerary.push({ kind: "checkin", when: card.checkin, title: `Check in: ${card.name}`, detail: `${where} · ${card.nights} night${card.nights === 1 ? "" : "s"} · ${card.room}` });
      itinerary.push({ kind: "checkout", when: card.checkout, title: `Check out: ${card.name}`, detail: where });
      dates.push(card.checkin, card.checkout);
    }
    destination ??= card.city || null;
    receipts.push({
      kind: "hotel",
      title: card.name,
      number: b.number,
      confirmation: b.confirmationCode,
      status: STATUS_LABEL[b.status] ?? b.status,
      amount: money(b.priceCents, b.currency),
      refunded: b.refundCents ? money(b.refundCents, b.currency) : null,
      at: (b.paidAt ?? b.createdAt).toISOString(),
      href: b.href,
      lines: [`Guest: ${b.firstName} ${b.lastName}`, `${niceDate(card.checkin)} – ${niceDate(card.checkout)}`, where].filter(Boolean),
    });
  }

  // Rental cars are booked on Discover Cars (Neon only links there), so the plan shows; the receipt comes from them.
  for (const c of shown.cars) {
    itinerary.push({ kind: "car-pickup", when: c.pickup, title: `Pick up rental car: ${c.location}`, detail: `Until ${niceDate(c.dropoff)} · booked on Discover Cars` });
    itinerary.push({ kind: "car-dropoff", when: c.dropoff, title: `Return rental car: ${c.location}`, detail: "Check the return time on your Discover Cars confirmation" });
    receipts.push({
      kind: "car",
      title: `Rental car: ${c.location}`,
      status: "Book on Discover Cars",
      amount: null,
      at: null,
      href: c.url,
      lines: [`${niceDate(c.pickup)} – ${niceDate(c.dropoff)}`, "You pay Discover Cars directly; your confirmation and receipt come from them."],
    });
  }

  if (shown.cart) {
    const items = shown.cart.items ?? [];
    for (const it of items)
      if (it.delivery)
        itinerary.push({ kind: "package", when: null, title: `Package: ${it.title ?? it.asin}`, detail: `Amazon's estimate when added: ${it.delivery} (depends on the address you check out with)` });
    receipts.push({
      kind: "amazon",
      title: `Amazon cart (${shown.cart.site})`,
      status: "Check out on Amazon",
      amount: null,
      at: null,
      href: shown.cart.url,
      lines: [
        ...items.map((it) => `${it.quantity} × ${it.title ?? it.asin}`),
        "You pay Amazon directly; your receipt and tracking come from Amazon.",
      ],
    });
  }

  for (const { card, at } of shown.emails) {
    if (card.status === "sent") itinerary.push({ kind: "email", when: null, title: `Emailed ${card.to}`, detail: card.subject });
    receipts.push({
      kind: "email",
      title: card.subject,
      status: card.status === "sent" ? "Sent" : card.status === "not_sent" ? "Not sent" : "Draft",
      amount: null,
      at,
      href: null,
      lines: [`To: ${card.to}`, ...(card.cc.length ? [`Cc: ${card.cc.join(", ")}`] : []), ...(card.note ? [card.note] : [])],
    });
  }

  // Dated things in time order, then the undated ones (packages, emails) in the order they happened.
  // A date without a time sorts at the usual hour: check-in in the afternoon, check-out in the morning.
  const key = (i: ItineraryItem) => (i.when!.length > 10 ? i.when! : `${i.when}T${{ checkin: "15:00", checkout: "11:00", "car-pickup": "12:00", "car-dropoff": "10:00" }[i.kind as string] ?? "00:00"}`);
  const dated = itinerary.filter((i) => i.when).sort((a, b) => key(a).localeCompare(key(b)));
  const undated = itinerary.filter((i) => !i.when);
  const sorted = dates.filter(Boolean).sort();
  const start = sorted[0] ?? null;
  const end = sorted[sorted.length - 1] ?? null;
  const cancelled = [...flights, ...hotels].every((b) => b.status === "CANCELLED");
  const phase = !start || !end ? "upcoming" : end < today ? "past" : start <= today ? "now" : "upcoming";
  const range = start && end ? (start === end ? niceDate(start) : `${niceDate(start)} – ${niceDate(end)}`) : "";
  return {
    chatId: chat.id,
    chatTitle: chat.title,
    title: [destination ?? chat.title, range].filter(Boolean).join(" · "),
    start,
    end,
    phase,
    cancelled,
    itinerary: [...dated, ...undated],
    receipts,
  };
}

/** Every trip in this owner's chats, soonest upcoming first, then past trips (most recent first). */
export async function tripsFor(
  owner: { customerId: string | null; where: Prisma.AssistantChatWhereInput },
  today = new Date().toISOString().slice(0, 10),
): Promise<Trip[]> {
  const where = owner.where;
  const chats = await prisma.assistantChat.findMany({ where: { ...where, userTurns: { gt: 0 } }, orderBy: { updatedAt: "desc" }, take: 200, select: { id: true, title: true, uiJson: true } });
  const shown = chats.map((c) => ({ chat: c, ...chatShown(c.uiJson) }));
  const flightIds = [...new Set(shown.flatMap((s) => [...s.flights]))];
  const hotelIds = [...new Set(shown.flatMap((s) => [...s.hotels]))];
  // A booking made by a signed-in customer only ever shows in that customer's trips.
  const mine = (b: { customerId: string | null }) => !b.customerId || b.customerId === owner.customerId;
  const [fbAll, hbAll] = await Promise.all([
    flightIds.length ? prisma.flightBooking.findMany({ where: { offerId: { in: flightIds }, status: { in: LIVE } } }) : [],
    hotelIds.length ? prisma.hotelBooking.findMany({ where: { offerId: { in: hotelIds }, status: { in: LIVE } } }) : [],
  ]);
  const fb = fbAll.filter(mine);
  const hb = hbAll.filter(mine);
  const flightLinks = new Map(await Promise.all(fb.map(async (b) => [b.id, `/flights/trip/${encodeURIComponent(b.number)}?t=${await tripToken(b.id)}`] as const)));
  const hotelLinks = new Map(await Promise.all(hb.map(async (b) => [b.id, `/hotels/stay/${encodeURIComponent(b.number)}?t=${await stayToken(b.id)}`] as const)));
  const trips: Trip[] = [];
  for (const s of shown) {
    const t = buildTrip(
      s.chat,
      fb.filter((b) => s.flights.has(b.offerId)).map((b) => ({ ...b, href: flightLinks.get(b.id)! })),
      hb.filter((b) => s.hotels.has(b.offerId)).map((b) => ({ ...b, href: hotelLinks.get(b.id)! })),
      today,
    );
    if (t) trips.push(t);
  }
  const rank = (t: Trip) => (t.phase === "past" || t.cancelled ? 1 : 0);
  return trips.sort((a, b) => rank(a) - rank(b) || (rank(a) ? (b.start ?? "").localeCompare(a.start ?? "") : (a.start ?? "9").localeCompare(b.start ?? "9")));
}
