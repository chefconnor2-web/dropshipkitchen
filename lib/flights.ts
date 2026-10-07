// Flight search for the chat: Duffel offers turned into cards, priced with our fee, filtered to what the
// shopper asked for and ranked (best, cheapest, fastest). Several searches run in parallel; results are
// remembered for a few minutes so a follow-up question answers at once.

import { processSingleton } from "@/lib/singleton";
import { getOffer, searchOffers, type DuffelOffer, type OfferRequestInput } from "@/lib/duffel";
import type { FlightCard, FlightSlice } from "@/lib/flights-shared";

/**
 * Our fee on every ticket: covers Duffel's per-booking fees, card processing and the AI that found it, plus
 * margin. FLIGHT_FEE_CENTS / FLIGHT_FEE_PCT override it. The shopper always sees the price with it included.
 */
export function flightFee(): { fixedCents: number; pct: number } {
  const fixed = Number(process.env.FLIGHT_FEE_CENTS);
  const pct = Number(process.env.FLIGHT_FEE_PCT);
  return { fixedCents: Number.isFinite(fixed) && fixed >= 0 ? fixed : 15_00, pct: Number.isFinite(pct) && pct >= 0 ? pct : 3 };
}

/** Duffel's total plus our fee, rounded up to a whole unit of the currency. */
export function priceWithFee(totalAmount: string | number, fee = flightFee()): number {
  const cents = Math.round(Number(totalAmount) * 100);
  return Math.ceil((cents * (1 + fee.pct / 100) + fee.fixedCents) / 100) * 100;
}

/** "PT11H30M" or "P1DT2H" → minutes. */
export function isoMinutes(d: string | null | undefined): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d ?? "");
  return m ? Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

function minutesBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(b + "Z") - Date.parse(a + "Z")) / 60_000));
}

export function toCard(o: DuffelOffer, fee = flightFee()): FlightCard {
  const slices: FlightSlice[] = o.slices.map((s) => {
    const segs = s.segments;
    const first = segs[0];
    const last = segs[segs.length - 1];
    return {
      from: s.origin.iata_code,
      fromCity: s.origin.city_name || s.origin.name || s.origin.iata_code,
      to: s.destination.iata_code,
      toCity: s.destination.city_name || s.destination.name || s.destination.iata_code,
      depart: first?.departing_at ?? "",
      arrive: last?.arriving_at ?? "",
      // Duffel's duration when given; otherwise the clock difference (local times, so only a fallback).
      durationMin: isoMinutes(s.duration) || (first && last ? minutesBetween(first.departing_at, last.arriving_at) : 0),
      stops: Math.max(0, segs.length - 1),
      via: segs.slice(0, -1).map((g) => g.destination.iata_code),
      segments: segs.map((g) => ({
        from: g.origin.iata_code,
        to: g.destination.iata_code,
        depart: g.departing_at,
        arrive: g.arriving_at,
        carrier: g.marketing_carrier?.name ?? o.owner.name,
        flight: `${g.marketing_carrier?.iata_code ?? ""}${g.marketing_carrier_flight_number ?? ""}`,
      })),
    };
  });
  // Bags and cabin as the first passenger gets them on the first flight.
  const pax = o.slices[0]?.segments[0]?.passengers?.[0];
  const bags = (type: string) => pax?.baggages?.filter((b) => b.type === type).reduce((n, b) => n + b.quantity, 0) ?? 0;
  return {
    kind: "flight",
    id: o.id,
    airline: o.owner.name,
    logo: o.owner.logo_symbol_url ?? null,
    priceCents: priceWithFee(o.total_amount, fee),
    currency: o.total_currency,
    cabin: pax?.cabin_class_marketing_name || "Economy",
    fareBrand: o.slices[0]?.fare_brand_name ?? null,
    checkedBags: bags("checked"),
    carryOn: bags("carry_on"),
    refundable: o.conditions?.refund_before_departure ? o.conditions.refund_before_departure.allowed : null,
    changeable: o.conditions?.change_before_departure ? o.conditions.change_before_departure.allowed : null,
    slices,
    expiresAt: o.expires_at,
  };
}

export interface FlightSearch {
  label: string;
  slices: Array<{ origin: string; destination: string; date: string }>;
  adults: number;
  childAges: number[];
  cabin: OfferRequestInput["cabin_class"];
  maxStops: number | null;
  departAfter: string;
  departBefore: string;
  checkedBag: boolean;
}

/** The shopper's must-haves that Duffel can't filter for us. */
export function keep(c: FlightCard, s: Pick<FlightSearch, "departAfter" | "departBefore" | "checkedBag" | "maxStops">): boolean {
  if (s.checkedBag && c.checkedBags < 1) return false;
  if (s.maxStops != null && c.slices.some((x) => x.stops > s.maxStops!)) return false;
  const t = c.slices[0]?.depart.slice(11, 16) ?? "";
  if (/^\d\d:\d\d$/.test(s.departAfter) && t < s.departAfter) return false;
  if (/^\d\d:\d\d$/.test(s.departBefore) && t > s.departBefore) return false;
  return true;
}

const totalMinutes = (c: FlightCard) => c.slices.reduce((n, s) => n + s.durationMin, 0);

/** Up to `n` picks: the best value first, then the cheapest and the fastest if they're different. */
export function rank(cards: FlightCard[], n = 3): FlightCard[] {
  if (!cards.length) return [];
  const minP = Math.min(...cards.map((c) => c.priceCents));
  const minT = Math.min(...cards.map(totalMinutes)) || 1;
  // An hour of travel is worth about 4% of the cheapest fare, and each stop a bit more on top.
  const score = (c: FlightCard) => c.priceCents / minP + ((totalMinutes(c) - minT) / 60) * 0.04 + c.slices.reduce((n, s) => n + s.stops, 0) * 0.05;
  const best = [...cards].sort((a, b) => score(a) - score(b));
  const cheapest = [...cards].sort((a, b) => a.priceCents - b.priceCents || totalMinutes(a) - totalMinutes(b));
  const fastest = [...cards].sort((a, b) => totalMinutes(a) - totalMinutes(b) || a.priceCents - b.priceCents);
  const out: FlightCard[] = [];
  for (const c of [best[0], cheapest[0], fastest[0], ...best]) if (c && !out.some((x) => x.id === c.id) && out.length < n) out.push(c);
  return out;
}

const cache = processSingleton("flight-search-cache", () => new Map<string, { at: number; cards: FlightCard[] }>());
const CACHE_MS = 8 * 60_000;

function requestOf(s: FlightSearch): OfferRequestInput {
  return {
    slices: s.slices.map((x) => ({ origin: x.origin.toUpperCase(), destination: x.destination.toUpperCase(), departure_date: x.date })),
    passengers: [...Array.from({ length: Math.max(1, s.adults) }, () => ({ type: "adult" as const })), ...s.childAges.map((age) => ({ age }))],
    cabin_class: s.cabin,
    ...(s.maxStops != null ? { max_connections: s.maxStops } : {}),
  };
}

/** Every offer for one search as cards (remembered for a few minutes; offers stay valid well beyond that). */
export async function searchFlights(s: FlightSearch): Promise<FlightCard[]> {
  const req = requestOf(s);
  const key = JSON.stringify(req);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cards;
  const cards = (await searchOffers(req)).map((o) => toCard(o));
  cache.set(key, { at: Date.now(), cards });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return cards;
}

/** One offer, re-priced now, with fare rules and extra bags. Null when it's gone. */
export async function flightDetails(offerId: string) {
  const o = await getOffer(offerId);
  const fee = flightFee();
  const bagPrices = (o.available_services ?? []).filter((x) => x.type === "baggage").map((x) => `${x.metadata?.maximum_weight_kg ? `${x.metadata.maximum_weight_kg} kg ` : ""}bag ${x.total_currency} ${Math.ceil(Number(x.total_amount))}`);
  const rule = (r?: { allowed: boolean; penalty_amount?: string | null; penalty_currency?: string | null } | null) =>
    !r ? "not stated" : !r.allowed ? "not allowed" : r.penalty_amount && Number(r.penalty_amount) > 0 ? `allowed, fee ${r.penalty_currency} ${r.penalty_amount}` : "allowed, no fee";
  return {
    card: toCard(o, fee),
    refund: rule(o.conditions?.refund_before_departure),
    change: rule(o.conditions?.change_before_departure),
    extraBags: bagPrices.slice(0, 4),
  };
}
