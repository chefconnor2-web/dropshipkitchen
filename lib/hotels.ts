// Hotel search for the chat: LiteAPI rates turned into hotel cards (one per hotel, its cheapest room), priced
// with our fee. Searches are plain API calls ranked in code, so they cost nothing in AI.

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { noLossCents } from "@/lib/margin";
import { searchRates, type LiteHotel, type LiteRate, type LiteRoomType, type RatesQuery } from "@/lib/liteapi";
import type { HotelCard } from "@/lib/flights-shared";

/** Our fee on a stay: HOTEL_FEE_CENTS fixed + HOTEL_FEE_PCT of the total (defaults $5 + 3%). */
export function hotelFee(): { fixedCents: number; pct: number } {
  const fixed = Number(process.env.HOTEL_FEE_CENTS);
  const pct = Number(process.env.HOTEL_FEE_PCT);
  return { fixedCents: Number.isFinite(fixed) && fixed >= 0 ? fixed : 5_00, pct: Number.isFinite(pct) && pct >= 0 ? pct : 3 };
}

/**
 * What LiteAPI bills our account card in (LITEAPI_BILLING_CURRENCY, default USD). A stay priced in another
 * currency costs us the card's conversion on top (HOTEL_FX_PCT, default 3%), so the floor allows for it.
 */
export function hotelFxPct(currency?: string): number {
  const billing = (process.env.LITEAPI_BILLING_CURRENCY?.trim() || "USD").toUpperCase();
  if (!currency || currency.toUpperCase() === billing) return 0;
  const pct = Number(process.env.HOTEL_FX_PCT);
  return Number.isFinite(pct) && pct >= 0 ? pct : 3;
}

/** LiteAPI's total plus our fee, never below cost, rounded up to a whole unit of the currency. */
export function stayWithFee(total: number, fee = hotelFee(), currency?: string): number {
  const cents = Math.round(total * 100);
  const floor = noLossCents(cents, { extraPct: hotelFxPct(currency) });
  return Math.ceil(Math.max(cents * (1 + fee.pct / 100) + fee.fixedCents, floor) / 100) * 100;
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

/** Taxes and fees the hotel collects at the property (LiteAPI marks them `included: false`), summed per kind. */
export function payAtHotel(rates: LiteRate[]): NonNullable<HotelCard["payAtHotel"]> {
  const out = new Map<string, { amountCents: number; currency: string; description: string }>();
  for (const r of rates)
    for (const t of r.retailRate?.taxesAndFees ?? []) {
      const cents = Math.round(Number(t.amount) * 100);
      if (t.included !== false || !t.currency || !(cents > 0)) continue;
      const description = (t.description ?? "").trim().toLowerCase() || "local taxes";
      const key = `${description}|${t.currency}`;
      const prev = out.get(key);
      out.set(key, { amountCents: (prev?.amountCents ?? 0) + cents, currency: t.currency.toUpperCase(), description });
    }
  return [...out.values()];
}

/** Taxes already inside the total (LiteAPI marks them `included: true`), e.g. GST/PST in Canada. */
export function taxesInTotal(rates: LiteRate[]): HotelCard["taxesIncluded"] {
  let cents = 0;
  let currency = "";
  for (const r of rates)
    for (const t of r.retailRate?.taxesAndFees ?? [])
      if (t.included === true && Number(t.amount) > 0 && t.currency && (!currency || currency === t.currency.toUpperCase())) {
        cents += Math.round(Number(t.amount) * 100);
        currency = t.currency.toUpperCase();
      }
  return cents > 0 ? { amountCents: cents, currency } : null;
}

// LiteAPI's catalog over-rates some chain hotels (it sends 4 stars for a Quality Inn). These brands are never
// above their class anywhere, so their stars are capped: [brand pattern, most stars].
const BRAND_STARS: Array<[RegExp, number]> = [
  [/\b(econo lodge|rodeway inn|super 8|motel 6|red roof|days inn|knights inn|travelodge|microtel|americas best value|studio 6|howard johnson)\b/i, 2],
  [/\b(quality inn|comfort inn|comfort suites|sleep inn|mainstay suites|suburban studios|clarion|best western(?! premier)|holiday inn express|hampton inn|fairfield inn|la quinta|country inn & suites|baymont|wingate|ramada|candlewood suites|tru by hilton|home2 suites|avid hotel)\b/i, 3],
];

/** The supplier's stars, capped for brands that are never rated higher. */
export function starsFor(name: string, stars: number | null): number | null {
  if (stars == null) return null;
  for (const [brand, most] of BRAND_STARS) if (brand.test(name)) return Math.min(stars, most);
  return stars;
}

/** When free cancellation ends: the first moment cancelling costs money ("2026-10-13 16:00 GMT"). */
export function freeCancelUntil(rate: LiteRate | undefined): string | null {
  if (rate?.cancellationPolicies?.refundableTag !== "RFN") return null;
  const paid = (rate.cancellationPolicies.cancelPolicyInfos ?? []).filter((i) => i.cancelTime && Number(i.amount) > 0).sort((a, b) => String(a.cancelTime).localeCompare(String(b.cancelTime)));
  const first = paid[0];
  if (!first?.cancelTime) return null;
  return `${first.cancelTime.replace("T", " ").slice(0, 16)} ${(first.timezone || "GMT").trim()}`;
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
      stars: starsFor(meta?.name ?? "", Number.isFinite(stars) && stars > 0 ? stars : null),
      rating: Number.isFinite(rating) && rating > 0 ? rating : null,
      address: meta?.address ?? "",
      city: meta?.city ?? q.cityName,
      latitude: Number.isFinite(Number(meta?.latitude)) ? Number(meta?.latitude) : null,
      longitude: Number.isFinite(Number(meta?.longitude)) ? Number(meta?.longitude) : null,
      room: rate?.name?.trim() || "Room",
      board: rate?.boardName?.trim() || "Room only",
      refundable: tag === "RFN" ? true : tag === "NRFN" ? false : null,
      freeCancelUntil: freeCancelUntil(rate),
      payAtHotel: payAtHotel(best.rt.rates ?? []),
      taxesIncluded: taxesInTotal(best.rt.rates ?? []),
      checkin: q.checkin,
      checkout: q.checkout,
      nights,
      adults: q.adults,
      childAges: q.childAges,
      priceCents: stayWithFee(best.total.amount, fee, best.total.currency),
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
  const t0 = Date.now();
  const r = await searchRates(q);
  const ms = Date.now() - t0;
  const cards = toCards(q, r.data ?? [], r.hotels ?? []);
  console.log(`[hotels] ${q.cityName}, ${q.countryCode} ${q.checkin}→${q.checkout} ${q.currency}: ${r.data?.length ?? 0} hotels with rates, ${r.hotels?.length ?? 0} with details, ${cards.length} cards, LiteAPI ${ms}ms`);
  // HOTEL_SAMPLE="Quality Inn": logs that hotel's raw details and first rate, to check what LiteAPI sends.
  const sample = process.env.HOTEL_SAMPLE?.trim().toLowerCase();
  if (sample) {
    const h = r.hotels?.find((x) => x.name?.toLowerCase().includes(sample));
    const rt = h && r.data?.find((d) => d.hotelId === h.id)?.roomTypes?.[0];
    if (h) console.log("[hotels] sample:", JSON.stringify({ hotel: { ...h, hotelDescription: undefined, description: undefined }, rate: rt?.rates?.[0] }).slice(0, 4000));
  }
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

/** Searches kept in memory for paging (cursor): the rest of the hotels come from here, not a second search. */
const kept = new Map<string, { cards: HotelCard[]; at: number }>();
const KEEP_MS = 30 * 60_000;

export function keepSearch(cards: HotelCard[]): string {
  const now = Date.now();
  for (const [k, v] of kept) if (now - v.at > KEEP_MS || kept.size > 500) kept.delete(k);
  const id = randomBytes(6).toString("base64url");
  kept.set(id, { cards, at: now });
  return id;
}

export function keptSearch(id: string): HotelCard[] | null {
  const v = kept.get(id);
  return v && Date.now() - v.at <= KEEP_MS ? v.cards : null;
}

const fold = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const GENERIC = new Set(["the", "hotel", "hotels", "and", "by", "inn", "inns", "suites", "suite", "resort", "motel", "lodge", "a", "at", "of", "de", "la", "le"]);
const near = (a: string, b: string) => {
  if (a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b))) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  return typos(a, b) <= 1;
};
/** Edit distance where swapping two neighbouring letters counts as one typo. */
function typos(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** Hotels whose name fuzzily matches `name` (every distinctive word found, one typo allowed), best first. */
export function matchHotels(cards: HotelCard[], name: string, city = ""): HotelCard[] {
  const cityWords = new Set(fold(city).split(" "));
  const words = fold(name).split(" ").filter(Boolean);
  const key = words.filter((w) => !GENERIC.has(w) && !cityWords.has(w));
  const want = key.length ? key : words;
  if (!want.length) return [];
  const scored = cards.map((c) => {
    const have = fold(c.name).split(" ");
    const hits = want.filter((w) => have.some((h) => near(w, h))).length;
    const extra = words.filter((w) => have.includes(w)).length;
    return { c, ok: hits === want.length, score: hits * 10 + extra };
  });
  return scored.filter((x) => x.ok).sort((a, b) => b.score - a.score || a.c.priceCents - b.c.priceCents).map((x) => x.c);
}

const EURO = "AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" ");
const CURRENCY: Record<string, string> = { US: "USD", CA: "CAD", GB: "GBP", AU: "AUD", NZ: "NZD", JP: "JPY", MX: "MXN", CH: "CHF", IN: "INR", SG: "SGD", HK: "HKD", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", AE: "AED", ZA: "ZAR", BR: "BRL", KR: "KRW", CN: "CNY", TH: "THB", IL: "ILS", TR: "TRY" };

/** The currency people in a country pay in (USD when we don't know it). */
export function localCurrency(country?: string | null): string {
  const c = (country ?? "").trim().toUpperCase();
  return CURRENCY[c] ?? (EURO.includes(c) ? "EUR" : "USD");
}
