// Flight search for the chat: Duffel offers turned into cards, priced with our fee, filtered to what the
// shopper asked for and ranked (best, cheapest, fastest). Several searches run in parallel; results are
// remembered for a few minutes so a follow-up question answers at once.

import { processSingleton } from "@/lib/singleton";
import { getOffer, searchOffers, type DuffelOffer, type OfferRequestInput } from "@/lib/duffel";
import { itineraryKey, type FareOption, type FareRule, type FlightCard, type FlightSlice } from "@/lib/flights-shared";

type Condition = { allowed: boolean; penalty_amount?: string | null; penalty_currency?: string | null } | null | undefined;
/** Duffel's change/refund condition as a rule the card and the planner can show. */
export function fareRule(c: Condition): FareRule {
  if (!c) return null;
  if (!c.allowed) return { kind: "no" };
  const fee = Number(c.penalty_amount ?? 0);
  return fee > 0 ? { kind: "fee", fee: `${c.penalty_currency ?? ""} ${Math.ceil(fee)}`.trim() } : { kind: "free" };
}

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
    ...(o.payment_requirements?.requires_instant_payment === false ? { holdable: true } : {}),
    changeRule: fareRule(o.conditions?.change_before_departure),
    refundRule: fareRule(o.conditions?.refund_before_departure),
    slices,
    expiresAt: o.expires_at,
  };
}

const fareOf = (c: FlightCard): FareOption => ({
  id: c.id,
  brand: c.fareBrand || c.cabin,
  priceCents: c.priceCents,
  checkedBags: c.checkedBags,
  carryOn: c.carryOn,
  changeRule: c.changeRule ?? null,
  refundRule: c.refundRule ?? null,
});

/**
 * One card per actual trip: airlines send each fare type (Basic, Standard, Flex…) of the same flights as its
 * own offer. Groups them by itinerary; each card is that trip's cheapest fare that fits, carrying every fare
 * type (cheapest of each kind, up to 4) so the shopper can pick a more flexible one.
 */
export function groupFares(cards: FlightCard[], fits: (c: FlightCard) => boolean = () => true): FlightCard[] {
  const byTrip = new Map<string, FlightCard[]>();
  for (const c of cards) {
    const k = itineraryKey(c);
    byTrip.set(k, [...(byTrip.get(k) ?? []), c]);
  }
  const out: FlightCard[] = [];
  for (const all of byTrip.values()) {
    const sorted = [...all].sort((a, b) => a.priceCents - b.priceCents);
    const base = sorted.find(fits);
    if (!base) continue;
    // The cheapest of each distinct fare (brand, bags and rules), so near-duplicates don't crowd the list.
    const seen = new Set<string>();
    const fares: FareOption[] = [];
    for (const c of sorted) {
      const f = fareOf(c);
      const sig = JSON.stringify([f.brand.toLowerCase(), f.checkedBags, f.changeRule?.kind, f.refundRule?.kind]);
      if (seen.has(sig)) continue;
      seen.add(sig);
      fares.push(f);
    }
    // Keep the chosen fare in the list even past the cap.
    const shown = fares.slice(0, 4);
    if (!shown.some((f) => f.id === base.id)) shown[shown.length - 1] = fareOf(base);
    out.push({ ...base, ...(shown.length > 1 ? { fares: shown.sort((a, b) => a.priceCents - b.priceCents) } : {}) });
  }
  return out;
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
  /** "changeable": changes allowed (any fee); "refundable": a refund allowed. Empty for any fare. */
  fare?: "" | "changeable" | "refundable";
}

/** The shopper's must-haves that Duffel can't filter for us. */
export function keep(c: FlightCard, s: Pick<FlightSearch, "departAfter" | "departBefore" | "checkedBag" | "maxStops" | "fare">): boolean {
  if (s.checkedBag && c.checkedBags < 1) return false;
  if (s.fare === "changeable" && !(c.changeRule ? c.changeRule.kind !== "no" : c.changeable)) return false;
  if (s.fare === "refundable" && !(c.refundRule ? c.refundRule.kind !== "no" : c.refundable)) return false;
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
