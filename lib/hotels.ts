// Hotel search for the chat: LiteAPI rates turned into hotel cards (one per hotel, its cheapest room), priced
// with our fee. Searches are plain API calls ranked in code, so they cost nothing in AI.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { searchRates, type LiteHotel, type LiteRoomType, type RatesQuery } from "@/lib/liteapi";
import type { HotelCard } from "@/lib/flights-shared";

/** Our fee on a stay: HOTEL_FEE_CENTS fixed + HOTEL_FEE_PCT of the total (defaults $5 + 3%). */
export function hotelFee(): { fixedCents: number; pct: number } {
  const fixed = Number(process.env.HOTEL_FEE_CENTS);
  const pct = Number(process.env.HOTEL_FEE_PCT);
  return { fixedCents: Number.isFinite(fixed) && fixed >= 0 ? fixed : 5_00, pct: Number.isFinite(pct) && pct >= 0 ? pct : 3 };
}

/** LiteAPI's total plus our fee, rounded up to a whole unit of the currency. */
export function stayWithFee(total: number, fee = hotelFee()): number {
  const cents = Math.round(total * 100);
  return Math.ceil((cents * (1 + fee.pct / 100) + fee.fixedCents) / 100) * 100;
}

/** A short, stable id for a LiteAPI offer (used in the booking link). */
export function cardId(offerId: string): string {
  return `ht_${createHash("sha256").update(offerId).digest("base64url").slice(0, 16)}`;
}

/** The LiteAPI offer behind a card. */
export function liteOfferId(c: HotelCard): string {
  return c.offerId ?? c.id;
}

export function nightsBetween(checkin: string, checkout: string): number {
  return Math.round((Date.parse(checkout) - Date.parse(checkin)) / 86400_000);
}

/** The whole-stay total of a room offer. */
export function offerTotal(rt: LiteRoomType): { amount: number; currency: string } | null {
  if (rt.offerRetailRate && Number.isFinite(Number(rt.offerRetailRate.amount))) return { amount: Number(rt.offerRetailRate.amount), currency: rt.offerRetailRate.currency };
  const totals = (rt.rates ?? []).map((r) => r.retailRate?.total?.[0]).filter((t): t is { amount: number; currency: string } => !!t);
  if (!totals.length) return null;
  return { amount: totals.reduce((n, t) => n + Number(t.amount), 0), currency: totals[0].currency };
}

/** One card per hotel (its cheapest room), cheapest first. */
export function toCards(q: RatesQuery, data: Array<{ hotelId: string; roomTypes?: LiteRoomType[] }>, hotels: LiteHotel[], fee = hotelFee()): HotelCard[] {
  const info = new Map(hotels.map((h) => [h.id, h]));
  const nights = nightsBetween(q.checkin, q.checkout);
  const cards: HotelCard[] = [];
  for (const h of data) {
    let best: { rt: LiteRoomType; total: { amount: number; currency: string } } | null = null;
    for (const rt of h.roomTypes ?? []) {
      const total = offerTotal(rt);
      if (rt.offerId && total && total.amount > 0 && (!best || total.amount < best.total.amount)) best = { rt, total };
    }
    if (!best) continue;
    const meta = info.get(h.hotelId);
    const rate = best.rt.rates?.[0];
    const tag = rate?.cancellationPolicies?.refundableTag;
    const stars = Number(meta?.stars ?? meta?.starRating);
    const rating = Number(meta?.rating);
    cards.push({
      kind: "hotel",
      id: cardId(best.rt.offerId),
      offerId: best.rt.offerId,
      hotelId: h.hotelId,
      name: meta?.name?.trim() || "Hotel",
      photo: meta?.main_photo || meta?.thumbnail || null,
      stars: Number.isFinite(stars) && stars > 0 ? stars : null,
      rating: Number.isFinite(rating) && rating > 0 ? rating : null,
      address: meta?.address ?? "",
      city: meta?.city ?? q.cityName,
      latitude: Number.isFinite(Number(meta?.latitude)) ? Number(meta?.latitude) : null,
      longitude: Number.isFinite(Number(meta?.longitude)) ? Number(meta?.longitude) : null,
      room: rate?.name?.trim() || "Room",
      board: rate?.boardName?.trim() || "Room only",
      refundable: tag === "RFN" ? true : tag === "NRFN" ? false : null,
      checkin: q.checkin,
      checkout: q.checkout,
      nights,
      adults: q.adults,
      childAges: q.childAges,
      priceCents: stayWithFee(best.total.amount, fee),
      currency: best.total.currency,
    });
  }
  return cards.sort((a, b) => a.priceCents - b.priceCents);
}

/** Up to `n` picks: the cheapest, the best rated, and good value in between, without repeats. */
export function pickHotels(cards: HotelCard[], n = 6, maxPerNightCents?: number, minStars?: number): HotelCard[] {
  const fit = cards.filter((c) => (!maxPerNightCents || c.priceCents / Math.max(1, c.nights) <= maxPerNightCents) && (!minStars || (c.stars ?? 0) >= minStars));
  const byRating = [...fit].sort((a, b) => (b.rating ?? b.stars ?? 0) - (a.rating ?? a.stars ?? 0) || a.priceCents - b.priceCents);
  const out: HotelCard[] = [];
  for (const c of [...fit.slice(0, 2), ...byRating.slice(0, 2), ...fit]) if (out.length < n && !out.some((o) => o.id === c.id)) out.push(c);
  return out;
}

export async function searchHotels(q: RatesQuery): Promise<HotelCard[]> {
  const r = await searchRates(q);
  const cards = toCards(q, r.data ?? [], r.hotels ?? []);
  console.log(`[hotels] ${q.cityName}, ${q.countryCode} ${q.checkin}→${q.checkout}: ${r.data?.length ?? 0} hotels with rates, ${r.hotels?.length ?? 0} with details, ${cards.length} cards`);
  // Rates came back but none could be read: log one so the response shape can be checked.
  if ((r.data?.length ?? 0) > 0 && cards.length === 0) console.warn("[hotels] unreadable rates sample:", JSON.stringify(r.data?.[0]).slice(0, 1500));
  return cards;
}

/** Remembered (by our short card id) so the booking page can show the hotel the shopper picked. */
export async function rememberOffers(cards: HotelCard[]) {
  for (const c of cards)
    await prisma.hotelOffer.upsert({ where: { offerId: c.id }, create: { offerId: c.id, cardJson: JSON.stringify(c) }, update: { cardJson: JSON.stringify(c) } }).catch(() => {});
}

export async function offerCard(offerId: string): Promise<HotelCard | null> {
  const row = await prisma.hotelOffer.findUnique({ where: { offerId } });
  return row ? (JSON.parse(row.cardJson) as HotelCard) : null;
}
