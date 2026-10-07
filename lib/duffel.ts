// Duffel Flights API client (https://duffel.com/docs/api/v2). Bearer token from DUFFEL_ACCESS_TOKEN; a
// duffel_test_ token only ever touches test mode (including the "Duffel Airways" test airline).
//   GET  /places/suggestions?query=        airports and cities by name
//   POST /air/offer_requests?return_offers  search: slices, passengers, cabin → offers
//   GET  /air/offers/{id}                   one offer, re-priced, with fare conditions and extras
// DUFFEL_API_URL is for tests only (a local stand-in for Duffel).

import { processSingleton } from "@/lib/singleton";

export function duffelConfigured(): boolean {
  return !!process.env.DUFFEL_ACCESS_TOKEN?.trim();
}

export function duffelTestMode(): boolean {
  return (process.env.DUFFEL_ACCESS_TOKEN ?? "").trim().startsWith("duffel_test_");
}

export class DuffelError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

// A few requests at a time: searches are heavy on Duffel's side and one chat turn can send several.
const MAX_CONCURRENT = 3;
const lane = processSingleton("duffel-lane", () => ({ active: 0, queue: [] as Array<() => void> }));

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (lane.active >= MAX_CONCURRENT) await new Promise<void>((r) => lane.queue.push(r));
  lane.active++;
  try {
    return await fn();
  } finally {
    lane.active--;
    lane.queue.shift()?.();
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const token = process.env.DUFFEL_ACCESS_TOKEN?.trim();
  if (!token) throw new DuffelError("Flights aren't set up: DUFFEL_ACCESS_TOKEN is missing.", 0);
  const base = (process.env.DUFFEL_API_URL || "https://api.duffel.com").replace(/\/$/, "");
  return slot(async () => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "duffel-version": "v2",
        accept: "application/json",
        "accept-encoding": "gzip",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify({ data: body }) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message?: string; title?: string; code?: string }> };
    if (!res.ok) {
      const e = json.errors?.[0];
      throw new DuffelError(e?.message || e?.title || `Duffel ${res.status}`, res.status, e?.code);
    }
    return json.data as T;
  });
}

// ---------- the parts of Duffel's objects we use ----------

export interface DuffelPlace {
  type: "airport" | "city";
  iata_code: string;
  name: string;
  city_name?: string | null;
  iata_country_code?: string | null;
  airports?: Array<{ iata_code: string; name: string }> | null;
}

export interface DuffelSegment {
  departing_at: string;
  arriving_at: string;
  origin: { iata_code: string; city_name?: string | null };
  destination: { iata_code: string; city_name?: string | null };
  marketing_carrier?: { name?: string; iata_code?: string } | null;
  marketing_carrier_flight_number?: string | null;
  passengers?: Array<{ baggages?: Array<{ type: string; quantity: number }>; cabin_class_marketing_name?: string | null }>;
}

export interface DuffelSlice {
  origin: { iata_code: string; city_name?: string | null; name?: string };
  destination: { iata_code: string; city_name?: string | null; name?: string };
  duration?: string | null;
  fare_brand_name?: string | null;
  segments: DuffelSegment[];
}

export interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at: string;
  owner: { name: string; iata_code?: string; logo_symbol_url?: string | null };
  slices: DuffelSlice[];
  passengers: Array<{ id: string; type?: string | null; age?: number | null }>;
  conditions?: {
    refund_before_departure?: { allowed: boolean; penalty_amount?: string | null; penalty_currency?: string | null } | null;
    change_before_departure?: { allowed: boolean; penalty_amount?: string | null; penalty_currency?: string | null } | null;
  } | null;
  available_services?: Array<{ type: string; total_amount: string; total_currency: string; metadata?: { type?: string; maximum_weight_kg?: number | null } }> | null;
}

export interface OfferRequestInput {
  slices: Array<{ origin: string; destination: string; departure_date: string }>;
  passengers: Array<{ type: "adult" } | { age: number }>;
  cabin_class: "economy" | "premium_economy" | "business" | "first";
  max_connections?: number;
}

export function placeSuggestions(query: string): Promise<DuffelPlace[]> {
  return call<DuffelPlace[]>("GET", `/places/suggestions?query=${encodeURIComponent(query)}`, undefined, 10_000);
}

/** One search. Airlines answer within the supplier timeout; the offers come back in the same response. */
export async function searchOffers(input: OfferRequestInput): Promise<DuffelOffer[]> {
  const r = await call<{ id: string; offers?: DuffelOffer[] }>("POST", "/air/offer_requests?return_offers=true&supplier_timeout=15000", input, 40_000);
  return r.offers ?? [];
}

export function getOffer(id: string): Promise<DuffelOffer> {
  return call<DuffelOffer>("GET", `/air/offers/${encodeURIComponent(id)}?return_available_services=true`, undefined, 20_000);
}
