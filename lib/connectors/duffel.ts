// Flights through Duffel: the planner finds airports, runs several searches at once (exact dates, nearby
// days, nearby airports, nonstop…) and shows the best picks as flight cards. Searches are plain API calls
// ranked in code, not AI scouts: faster, and they cost nothing in AI.

import { duffelConfigured, duffelTestMode, placeSuggestions, DuffelError } from "@/lib/duffel";
import { flightDetails, keep, rank, searchFlights, type FlightSearch } from "@/lib/flights";
import { clock, dayShift, durationLabel, flightPrice, stopsLabel, type FlightCard } from "@/lib/flights-shared";
import type { Connector } from "./types";

const MAX_SEARCHES = 6;
const CABINS = ["economy", "premium_economy", "business", "first"] as const;

const str = (v: unknown, max = 40) => String(v ?? "").trim().slice(0, max);
// Not cut to 3 letters: "Vancouver" must fail the code check, not become "VAN".
const iata = (v: unknown) => str(v, 12).toUpperCase();
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Validates one search from the model; returns why it's unusable instead of throwing. */
export function parseSearch(raw: unknown, today: string): FlightSearch | string {
  const o = (raw ?? {}) as Record<string, unknown>;
  const slices = (Array.isArray(o.slices) ? o.slices : []).slice(0, 4).map((x) => {
    const s = (x ?? {}) as Record<string, unknown>;
    return { origin: iata(s.origin), destination: iata(s.destination), date: str(s.date, 10) };
  });
  if (!slices.length) return "a search needs at least one flight (origin, destination, date)";
  for (const s of slices) {
    if (!/^[A-Z]{3}$/.test(s.origin) || !/^[A-Z]{3}$/.test(s.destination)) return `use 3-letter airport or city codes (got ${s.origin || "?"} → ${s.destination || "?"}); call find_places first`;
    if (!isDate(s.date)) return `dates must be YYYY-MM-DD (got "${s.date}")`;
    if (s.date < today) return `${s.date} is in the past (today is ${today})`;
  }
  const adults = Math.min(9, Math.max(1, Math.round(Number(o.adults) || 1)));
  const childAges = (Array.isArray(o.child_ages) ? o.child_ages : []).map((a) => Math.round(Number(a))).filter((a) => a >= 0 && a < 18).slice(0, 8);
  const cabin = CABINS.includes(o.cabin as (typeof CABINS)[number]) ? (o.cabin as FlightSearch["cabin"]) : "economy";
  const stops = Math.round(Number(o.max_stops));
  return {
    label: str(o.label, 30) || "Flights",
    slices,
    adults,
    childAges,
    cabin,
    maxStops: Number.isFinite(stops) && stops >= 0 ? Math.min(stops, 2) : null,
    departAfter: str(o.depart_after, 5),
    departBefore: str(o.depart_before, 5),
    checkedBag: o.checked_bag === true,
  };
}

/** One line per pick for the planner: everything it needs to compare and explain, nothing it doesn't. */
export function describe(c: FlightCard): Record<string, unknown> {
  return {
    offer_id: c.id,
    airline: c.airline,
    price: flightPrice(c),
    flights: c.slices.map((s) => `${s.from} ${clock(s.depart)} → ${s.to} ${clock(s.arrive)}${dayShift(s.depart, s.arrive)} (${s.depart.slice(0, 10)}), ${durationLabel(s.durationMin)}, ${stopsLabel(s)}`),
    cabin: c.cabin + (c.fareBrand ? ` (${c.fareBrand})` : ""),
    bags: `${c.checkedBags} checked, ${c.carryOn} carry-on`,
    refundable: c.refundable,
  };
}

export const duffelConnector: Connector = {
  id: "duffel",
  label: "Flights (Duffel)",
  enabled: duffelConfigured,
  prompt: (today) => `
Flights:
- You can also find flights for shoppers (real airline fares through Duffel${duffelTestMode() ? "; this is TEST mode, so results include the fictional test airline \"Duffel Airways\"" : ""}). Today is ${today}.
- Use find_places when you don't know an airport or city code. City codes (YVR, YTO for all Toronto airports, LON, TYO) search every airport in that city.
- Search with find_flights, all angles in ONE call: the exact dates, and when the shopper is flexible, nearby days (±1–3), nearby airports, or nonstop only. Up to ${MAX_SEARCHES} searches. Give each a short label the shopper sees ("Exact dates", "Leave a day earlier", "Nonstop"). One-way is one slice; a return trip is two slices (there and back).
- If the destination or rough dates are missing, ask once. Otherwise assume 1 adult in economy, any number of stops, and say what you assumed.
- Only mention flights find_flights returned, at the price it returned (our fee is included; show the currency as given). Never invent flights, times or prices. Times are local at each airport.
- Lead with the best pick and why (price, time, stops, bags), then mention the alternatives. The shopper sees a card for every pick, so don't repeat every detail.
- Use get_flight for fare rules (refunds, changes) and extra bag prices before answering those questions.
- Booking flights in the chat is coming soon: shoppers can't buy a ticket here yet. If they want to book, say so briefly and that the fare shown can change until booked.`,
  tools: [
    {
      name: "find_places",
      description: "Look up airports and cities by name. Returns IATA codes (airports and city codes covering several airports).",
      strict: true,
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "A city or airport name, e.g. 'Vancouver', 'Tokyo Haneda'" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "find_flights",
      description: `Search live flights, several searches at once in parallel (up to ${MAX_SEARCHES}). Returns up to 3 picks per search (best, cheapest, fastest) with offer_id, airline, price (our fee included), times, stops and bags. The shopper sees them as flight cards.`,
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          searches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short label shown to the shopper, e.g. 'Exact dates', 'Nonstop', 'Fly Nov 2'" },
                slices: {
                  type: "array",
                  description: "One per flight: one-way = 1, return = 2 (outbound and back), multi-city = up to 4.",
                  items: {
                    type: "object",
                    properties: {
                      origin: { type: "string", description: "3-letter IATA airport or city code" },
                      destination: { type: "string", description: "3-letter IATA airport or city code" },
                      date: { type: "string", description: "Departure date, YYYY-MM-DD" },
                    },
                    required: ["origin", "destination", "date"],
                    additionalProperties: false,
                  },
                },
                adults: { type: "integer", description: "Adults (12+), 1-9" },
                child_ages: { type: "array", items: { type: "integer" }, description: "Age of each child under 12 (0 for an infant), or empty" },
                cabin: { type: "string", enum: [...CABINS] },
                max_stops: { type: "integer", description: "0 for nonstop only, 1 or 2; -1 for any" },
                depart_after: { type: "string", description: "Earliest departure time of the first flight, HH:MM, or empty" },
                depart_before: { type: "string", description: "Latest departure time of the first flight, HH:MM, or empty" },
                checked_bag: { type: "boolean", description: "true when the shopper needs a checked bag included" },
              },
              required: ["label", "slices", "adults", "child_ages", "cabin", "max_stops", "depart_after", "depart_before", "checked_bag"],
              additionalProperties: false,
            },
          },
        },
        required: ["searches"],
        additionalProperties: false,
      },
    },
    {
      name: "get_flight",
      description: "Re-check one flight offer now: current price, refund and change rules, and extra bag prices.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { offer_id: { type: "string", description: "offer_id from find_flights" } },
        required: ["offer_id"],
        additionalProperties: false,
      },
    },
  ],
  async run(tool, input, ctx) {
    const today = new Date().toISOString().slice(0, 10);
    const failed = (e: unknown) => ({ content: `Flight search failed: ${e instanceof DuffelError || e instanceof Error ? e.message : String(e)}`, isError: true });

    if (tool === "find_places") {
      const q = str(input.query, 60);
      if (q.length < 2) return { content: "Give at least two letters.", isError: true };
      try {
        const places = await placeSuggestions(q);
        return {
          content: JSON.stringify(
            places.slice(0, 8).map((p) => ({
              code: p.iata_code,
              type: p.type,
              name: p.name,
              city: p.city_name ?? undefined,
              country: p.iata_country_code ?? undefined,
              airports: p.type === "city" ? p.airports?.map((a) => `${a.iata_code} ${a.name}`) : undefined,
            })),
          ),
        };
      } catch (e) {
        return failed(e);
      }
    }

    if (tool === "find_flights") {
      const raw = (Array.isArray(input.searches) ? input.searches : []).slice(0, MAX_SEARCHES);
      if (!raw.length) return { content: "No searches given.", isError: true };
      ctx.progress(`Searching ${raw.length} flight option${raw.length === 1 ? "" : "s"} with the airlines…`);
      const results = await Promise.all(
        raw.map(async (r) => {
          const s = parseSearch(r, today);
          if (typeof s === "string") return { label: str((r as Record<string, unknown>)?.label, 30) || "Flights", error: s };
          try {
            const all = await searchFlights(s);
            const fit = all.filter((c) => keep(c, s));
            const picks = rank(fit).map((c) => ({ ...c, group: s.label }));
            if (picks.length) ctx.show(s.label, picks);
            return { label: s.label, offers_found: all.length, matching: fit.length, picks: picks.map(describe) };
          } catch (e) {
            return { label: s.label, error: failed(e).content };
          }
        }),
      );
      return { content: JSON.stringify(results) };
    }

    if (tool === "get_flight") {
      const id = str(input.offer_id, 80);
      if (!/^off_[A-Za-z0-9]+$/.test(id)) return { content: "Use an offer_id from find_flights.", isError: true };
      ctx.progress("Checking the fare with the airline…");
      try {
        const d = await flightDetails(id);
        return { content: JSON.stringify({ ...describe(d.card), refund_before_departure: d.refund, change_before_departure: d.change, extra_bags: d.extraBags, price_valid_until: d.card.expiresAt }) };
      } catch (e) {
        if (e instanceof DuffelError && e.status === 404) return { content: "That fare is no longer available. Search again for current prices.", isError: true };
        return failed(e);
      }
    }
    return { content: `Unknown tool ${tool}.`, isError: true };
  },
};
