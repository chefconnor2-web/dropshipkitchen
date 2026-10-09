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

/** Our general affiliate link, as the Discover Cars dashboard gives it. */
export function discoverCarsUrl(): string {
  return `https://www.discovercars.com/?${new URLSearchParams({ a_aid: process.env.DISCOVERCARS_AFFILIATE_ID?.trim() ?? "" })}`;
}

export function parseCarSearch(o: Record<string, unknown>, today: string): { location: string; pickup: string; dropoff: string } | string {
  const location = str(o.location, 80);
  const pickup = str(o.pickup_date, 10);
  const dropoff = str(o.dropoff_date, 10);
  if (!location) return "give the pickup city or airport";
  if (!isDate(pickup) || !isDate(dropoff)) return "dates must be YYYY-MM-DD";
  if (pickup < today) return `${pickup} is in the past (today is ${today})`;
  if (dropoff < pickup) return "drop-off must be on or after pick-up";
  return { location, pickup, dropoff };
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
          pickup_date: { type: "string", description: "YYYY-MM-DD" },
          dropoff_date: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["location", "pickup_date", "dropoff_date"],
        additionalProperties: false,
      },
    },
  ],
  async run(tool, input, ctx) {
    if (tool !== "rental_car_link") return { content: `Unknown tool ${tool}.`, isError: true };
    const s = parseCarSearch(input, new Date().toISOString().slice(0, 10));
    if (typeof s === "string") return { content: `Can't make the link: ${s}.`, isError: true };
    const card: CarRentalCard = { kind: "car", id: `car_${randomBytes(5).toString("hex")}`, ...s, url: discoverCarsUrl() };
    ctx.show("", [card]);
    return { content: JSON.stringify({ ok: true, shown_as_card: true, note: "The shopper enters the place and dates on Discover Cars; the card shows them what to enter." }) };
  },
};
