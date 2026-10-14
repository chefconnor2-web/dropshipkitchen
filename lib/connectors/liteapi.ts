// Hotels through LiteAPI: the planner searches a city for the dates, and the shopper sees hotel cards with a
// Book button. Like flights, searches are plain API calls ranked in code (no AI scouts), and booking happens
// on our page: pay by card, then the room is booked straight away.

import { liteapiConfigured, liteapiTestMode, LiteapiError } from "@/lib/liteapi";
import { keepSearch, keptSearch, matchHotels, pickHotels, rememberOffers, searchHotels } from "@/lib/hotels";
import { isoPrice, payAtHotelLabel, type HotelCard } from "@/lib/flights-shared";
import type { Connector } from "./types";

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export interface HotelSearch {
  cityName: string;
  countryCode: string;
  checkin: string;
  checkout: string;
  adults: number;
  childAges: number[];
  maxPerNightCents?: number;
  minStars?: number;
  /** ISO currency the prices come in (LiteAPI prices in it, in the same call). */
  currency: string;
  /** A hotel the shopper named: matches go first. */
  hotelName?: string;
  /** Hotels per page (default 6). */
  maxResults: number;
}

/** The page after this one: "<search id>.<offset>". */
export function parseCursor(cursor: string): { id: string; offset: number } | null {
  const m = /^([A-Za-z0-9_-]{4,16})\.(\d{1,3})$/.exec(cursor.trim());
  return m ? { id: m[1], offset: Number(m[2]) } : null;
}

export const PRICE_NOTE =
  "total = the whole stay: room, the taxes and fees charged when booking (taxes_in_total shows how much of it is tax), and Chit's fee. It does NOT include pay_at_hotel (local taxes or resort fees the hotel collects at check-in, in the hotel's currency). per_night = total ÷ nights.";

/** Validates the model's search; returns why it's unusable instead of throwing. */
export function parseHotelSearch(o: Record<string, unknown>, today: string): HotelSearch | string {
  const cityName = str(o.city, 60);
  // Not cut to 2 letters: "Japan" must fail the code check, not become "JA".
  const countryCode = str(o.country_code, 8).toUpperCase();
  const checkin = str(o.checkin, 10);
  const checkout = str(o.checkout, 10);
  if (!cityName) return "give the city";
  if (!/^[A-Z]{2}$/.test(countryCode)) return "give the 2-letter country code (e.g. JP, US, CA)";
  if (!isDate(checkin) || !isDate(checkout)) return "dates must be YYYY-MM-DD";
  if (checkin < today) return `${checkin} is in the past (today is ${today})`;
  const nights = Math.round((Date.parse(checkout) - Date.parse(checkin)) / 86400_000);
  if (nights < 1) return "check-out must be after check-in";
  if (nights > 30) return "stays are limited to 30 nights";
  const adults = Math.min(8, Math.max(1, Math.round(Number(o.adults) || 1)));
  const childAges = (Array.isArray(o.child_ages) ? o.child_ages : []).map((a) => Math.round(Number(a))).filter((a) => a >= 0 && a < 18).slice(0, 6);
  const max = Number(o.max_price_per_night);
  const stars = Math.round(Number(o.min_stars));
  const cur = str(o.currency, 3).toUpperCase();
  const hotelName = str(o.hotel_name, 80);
  const n = Math.round(Number(o.max_results));
  return {
    cityName,
    countryCode,
    checkin,
    checkout,
    adults,
    childAges,
    maxPerNightCents: max > 0 ? Math.round(max * 100) : undefined,
    minStars: stars >= 1 && stars <= 5 ? stars : undefined,
    currency: /^[A-Z]{3}$/.test(cur) ? cur : "USD",
    hotelName: hotelName || undefined,
    maxResults: n >= 1 ? Math.min(n, 30) : 6,
  };
}

export function describeHotel(c: HotelCard): Record<string, unknown> {
  return {
    offer_id: c.id,
    hotel: c.name,
    stars: c.stars ?? undefined,
    guest_rating: c.rating ?? undefined,
    area: c.address || c.city,
    room: c.room,
    meals: c.board,
    refundable: c.refundable,
    free_cancellation_until: c.refundable ? (c.freeCancelUntil ?? "ask the hotel (deadline not given)") : undefined,
    currency: c.currency.toUpperCase(),
    total: isoPrice(c),
    per_night: isoPrice({ priceCents: Math.round(c.priceCents / Math.max(1, c.nights)), currency: c.currency }),
    taxes_in_total: c.taxesIncluded ? isoPrice({ priceCents: c.taxesIncluded.amountCents, currency: c.taxesIncluded.currency }) : undefined,
    pay_at_hotel: payAtHotelLabel(c) ?? "none listed",
    nights: c.nights,
  };
}

/** The ranked list: picks (cheapest, best rated, value), then every other fitting hotel by price; named hotels first. */
export function rankHotels(all: HotelCard[], s: Pick<HotelSearch, "maxPerNightCents" | "minStars" | "hotelName" | "cityName">) {
  const ranked = pickHotels(all, all.length, s.maxPerNightCents, s.minStars);
  if (!s.hotelName) return { ranked, named: null };
  // Matched against every hotel with rooms (budget and stars don't hide the one they named).
  const hits = matchHotels(all, s.hotelName, s.cityName);
  const ids = new Set(hits.map((h) => h.id));
  return { ranked: [...hits, ...ranked.filter((c) => !ids.has(c.id))], named: hits };
}

/** One page of a ranked list, with the cursor for the next. */
export function hotelPage(ranked: HotelCard[], searchId: string, offset: number, n: number) {
  const page = ranked.slice(offset, offset + n);
  const next = offset + n < ranked.length ? `${searchId}.${offset + n}` : undefined;
  return { page, next, remaining: Math.max(0, ranked.length - offset - n) };
}

export const liteapiConnector: Connector = {
  id: "liteapi",
  label: "Hotels (LiteAPI)",
  enabled: liteapiConfigured,
  prompt: (today) => `
Hotels:
- You can find and book hotels (live rates through LiteAPI${liteapiTestMode() ? "; this is TEST mode, so bookings are simulated and nobody is charged by the hotel" : ""}). Today is ${today}.
- Search with find_hotels: the city, its 2-letter country code, check-in and check-out dates, and the guests. After a flight is booked or chosen, offer a hotel for those dates at the destination.
- If dates or city are missing, ask once (use the flight dates when there is one). Assume 2 adults only if the shopper said "we"; otherwise 1 adult, and say what you assumed.
- Only mention hotels find_hotels returned, at the total it returned (our fee and taxes the hotel collects up front are included; some hotels add a local city tax at check-in). Never invent hotels, prices or amenities.
- Lead with the best pick and why (price, rating, area, refundable), then the alternatives. The shopper sees a card for every pick with a Book button; booking happens on our page (guest name, then card payment) and confirms straight away. You can't book for them.
- Getting there: hotel cards and the booking page have a "Ride there" button that opens Uber with the hotel address filled in.`,
  tools: [
    {
      name: "find_hotels",
      description: "Search live hotel rates in a city for the dates. Returns up to 6 picks (cheapest, best rated, good value) with offer_id, total for the stay (our fee included), per-night price, room, meals and refundability. The shopper sees them as hotel cards with a Book button.",
      input_schema: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name, e.g. 'Tokyo', 'New York'" },
          country_code: { type: "string", description: "2-letter ISO country code, e.g. JP, US" },
          checkin: { type: "string", description: "YYYY-MM-DD" },
          checkout: { type: "string", description: "YYYY-MM-DD" },
          adults: { type: "integer", description: "Adults, 1-8" },
          child_ages: { type: "array", items: { type: "integer" }, description: "Age of each child, or empty" },
          max_price_per_night: { type: "number", description: "Budget per night in the shopper's currency, or 0 for any" },
          min_stars: { type: "integer", description: "Minimum star rating 1-5, or 0 for any" },
          hotel_name: { type: "string", description: "A hotel the shopper named, e.g. 'Lakeview'; matches go first" },
        },
        required: ["city", "country_code", "checkin", "checkout", "adults", "child_ages", "max_price_per_night", "min_stars"],
        additionalProperties: false,
      },
    },
  ],
  async run(tool, input, ctx) {
    if (tool !== "find_hotels") return { content: `Unknown tool ${tool}.`, isError: true };
    const s = parseHotelSearch(input, new Date().toISOString().slice(0, 10));
    if (typeof s === "string") return { content: `Can't search: ${s}.`, isError: true };
    const group = `Hotels in ${s.cityName}`;
    const cursor = typeof input.cursor === "string" && input.cursor ? parseCursor(input.cursor) : null;
    if (input.cursor && !cursor) return { content: "That cursor isn't valid. Search again.", isError: true };
    try {
      let ranked: HotelCard[];
      let searchId: string;
      let total: number | undefined;
      let named: HotelCard[] | null = null;
      if (cursor) {
        // The next page comes from the kept search: no second call to LiteAPI.
        const kept = keptSearch(cursor.id);
        if (!kept) return { content: "Those results expired (they're kept 30 minutes). Search again.", isError: true };
        ranked = kept;
        searchId = cursor.id;
      } else {
        ctx.progress(`Checking hotel rates in ${s.cityName}…`);
        const all = await searchHotels({ ...s, guestNationality: s.countryCode === "CA" ? "CA" : "US" });
        ({ ranked, named } = rankHotels(all, s));
        searchId = keepSearch(ranked);
        total = all.length;
      }
      const { page, next, remaining } = hotelPage(ranked, searchId, cursor?.offset ?? 0, s.maxResults);
      const picks = page.map((c) => ({ ...c, group }));
      if (picks.length) {
        await rememberOffers(picks);
        ctx.show(group, picks);
      }
      const nameNote = !named || !s.hotelName ? undefined : named.length
        ? `${named.length} hotel${named.length === 1 ? "" : "s"} matching "${s.hotelName}" ha${named.length === 1 ? "s" : "ve"} rooms for these dates: listed first (${named.map((n) => n.name).join("; ")}).`
        : `${s.hotelName}: no rooms for these dates (sold out, or not sold through our supplier). The other hotels with rooms are below.` +
          (total !== undefined && total >= 60 ? " This city search covers the first 60 hotels with rooms, so a hotel outside them may still have some." : "");
      return {
        content: JSON.stringify({
          ...(total !== undefined ? { hotels_with_rooms: total } : {}),
          matching: ranked.length,
          ...(nameNote ? { hotel_name_result: nameNote } : {}),
          currency: picks[0]?.currency.toUpperCase() ?? s.currency,
          price_note: PRICE_NOTE,
          picks: picks.map(describeHotel),
          ...(next ? { next_cursor: next, more: `${remaining} more hotel${remaining === 1 ? "" : "s"}: pass cursor "${next}" for the next ${Math.min(remaining, s.maxResults)} (no new search).` } : {}),
        }),
      };
    } catch (e) {
      console.error("[hotels] search failed:", e instanceof Error ? e.message : e);
      return { content: `Hotel search failed: ${e instanceof LiteapiError || e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  },
};
