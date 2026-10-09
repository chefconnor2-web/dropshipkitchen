// Hotels through LiteAPI: the planner searches a city for the dates, and the shopper sees hotel cards with a
// Book button. Like flights, searches are plain API calls ranked in code (no AI scouts), and booking happens
// on our page: pay by card, then the room is booked straight away.

import { liteapiConfigured, liteapiTestMode, LiteapiError } from "@/lib/liteapi";
import { pickHotels, rememberOffers, searchHotels } from "@/lib/hotels";
import { stayPrice, type HotelCard } from "@/lib/flights-shared";
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
}

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
  return { cityName, countryCode, checkin, checkout, adults, childAges, maxPerNightCents: max > 0 ? Math.round(max * 100) : undefined, minStars: stars >= 1 && stars <= 5 ? stars : undefined };
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
    total: stayPrice(c),
    per_night: stayPrice({ priceCents: Math.round(c.priceCents / Math.max(1, c.nights)), currency: c.currency }),
    nights: c.nights,
  };
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
      strict: true,
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
    ctx.progress(`Checking hotel rates in ${s.cityName}…`);
    try {
      const all = await searchHotels({ ...s, currency: "USD", guestNationality: s.countryCode === "CA" ? "CA" : "US" });
      const picks = pickHotels(all, 6, s.maxPerNightCents, s.minStars).map((c) => ({ ...c, group: `Hotels in ${s.cityName}` }));
      if (picks.length) {
        await rememberOffers(picks);
        ctx.show(`Hotels in ${s.cityName}`, picks);
      }
      return { content: JSON.stringify({ hotels_with_rooms: all.length, matching: picks.length, picks: picks.map(describeHotel) }) };
    } catch (e) {
      return { content: `Hotel search failed: ${e instanceof LiteapiError || e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  },
};
