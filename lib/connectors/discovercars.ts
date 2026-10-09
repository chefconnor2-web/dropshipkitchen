// Rental cars through Discover Cars, as an affiliate: Neon shows a card with where and when, and a button to
// Discover Cars (our affiliate link), where the shopper compares cars from rental companies and books. They pay
// Discover Cars directly; we earn a commission on completed rentals. No payment, stock or risk on our side.
//
// DISCOVERCARS_AFFILIATE_ID  the a_aid from the Discover Cars affiliate dashboard

import { randomBytes } from "node:crypto";
import type { CarRentalCard } from "@/lib/flights-shared";
import type { Connector } from "./types";

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function discoverCarsConfigured(): boolean {
  return !!process.env.DISCOVERCARS_AFFILIATE_ID?.trim();
}

// Location pages, as the Discover Cars landing page generator makes them: /<country>/<city>/<airport code>,
// e.g. /canada/vancouver/yvr. Only countries whose page names we've confirmed get a location page; anywhere
// else opens the search on the home page (a guessed page name could be a dead link).
const COUNTRY_PAGES: Record<string, string> = { CA: "canada" };

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Our affiliate link: the location page when we know its address, else the home page. */
export function discoverCarsUrl(where?: { countryCode?: string; city?: string; airport?: string }): string {
  const q = new URLSearchParams({ a_aid: process.env.DISCOVERCARS_AFFILIATE_ID?.trim() ?? "" });
  const country = where?.countryCode ? COUNTRY_PAGES[where.countryCode.toUpperCase()] : undefined;
  const city = where?.city ? slug(where.city) : "";
  if (!country || !city) return `https://www.discovercars.com/?${q}`;
  const airport = /^[A-Za-z]{3}$/.test(where?.airport ?? "") ? `/${where!.airport!.toLowerCase()}` : "";
  return `https://www.discovercars.com/${country}/${city}${airport}?${q}`;
}

export function parseCarSearch(
  o: Record<string, unknown>,
  today: string,
): { location: string; pickup: string; dropoff: string; countryCode: string; city: string; airport: string } | string {
  const location = str(o.location, 80);
  const countryCode = str(o.country_code, 8).toUpperCase();
  const city = str(o.city, 60);
  const airport = str(o.airport_code, 8).toUpperCase();
  const pickup = str(o.pickup_date, 10);
  const dropoff = str(o.dropoff_date, 10);
  if (!location) return "give the pickup city or airport";
  if (!isDate(pickup) || !isDate(dropoff)) return "dates must be YYYY-MM-DD";
  if (pickup < today) return `${pickup} is in the past (today is ${today})`;
  if (dropoff < pickup) return "drop-off must be on or after pick-up";
  return { location, pickup, dropoff, countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : "", city, airport: /^[A-Z]{3}$/.test(airport) ? airport : "" };
}

export const discoverCarsConnector: Connector = {
  id: "discovercars",
  label: "Rental cars (Discover Cars)",
  enabled: discoverCarsConfigured,
  prompt: () => `
Rental cars:
- For rental cars, use rental_car_link with the pickup city or airport and the dates. The shopper sees a card with a "Find a car" button that opens Discover Cars, which compares cars from the rental companies there; they pick, pay and book on Discover Cars.
- You can't see car prices or availability, so never quote either or promise a car type. Say what to search for and tips (book early, check the fuel and mileage policy, what deposit to expect).
- After a flight or hotel is booked or chosen, offer a car for those dates at the destination airport, once.`,
  tools: [
    {
      name: "rental_car_link",
      description: "Show a rental car card for a pickup place and dates, with a button to compare and book cars on Discover Cars.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          location: { type: "string", description: "Pickup city or airport as people would search it, e.g. 'Vancouver Airport (YVR)'" },
          city: { type: "string", description: "The city alone, in English, e.g. 'Vancouver'" },
          country_code: { type: "string", description: "2-letter country code, e.g. CA" },
          airport_code: { type: "string", description: "3-letter airport code when picking up at an airport, or empty" },
          pickup_date: { type: "string", description: "YYYY-MM-DD" },
          dropoff_date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["location", "city", "country_code", "airport_code", "pickup_date", "dropoff_date"],
        additionalProperties: false,
      },
    },
  ],
  async run(tool, input, ctx) {
    if (tool !== "rental_car_link") return { content: `Unknown tool ${tool}.`, isError: true };
    const s = parseCarSearch(input, new Date().toISOString().slice(0, 10));
    if (typeof s === "string") return { content: `Can't make the link: ${s}.`, isError: true };
    const card: CarRentalCard = {
      kind: "car",
      id: `car_${randomBytes(5).toString("hex")}`,
      location: s.location,
      pickup: s.pickup,
      dropoff: s.dropoff,
      url: discoverCarsUrl({ countryCode: s.countryCode, city: s.city, airport: s.airport }),
    };
    ctx.show("", [card]);
    return { content: JSON.stringify({ ok: true, shown_as_card: true, note: "The button opens Discover Cars on the pickup location (or its search page); the shopper enters the dates there." }) };
  },
};
