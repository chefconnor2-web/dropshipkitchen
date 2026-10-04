// Customer shipping quotes: CJ's live freight price for the exact VIDs, passed through at cost.
// Method names are mapped to our own tiers (Standard / Express) so CJ's carrier names never reach the browser.

import { freightCalculate } from "@/lib/cj/client";
import { chooseFromCountry, originCandidates } from "@/lib/fulfillment";
import { choosePlan, planParcels, planWindow, type ParcelPlanEntry } from "@/lib/parcels";

export const SHIP_COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "CA", name: "Canada" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "IE", name: "Ireland" },
];

export function countryLabel(code: string): string {
  return SHIP_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

/** "X can’t ship to Canada…" naming the products that block a cart (VIDs → names via `nameOf`). */
export function blockedMessage(blocked: string[], nameOf: (vid: string) => string | undefined, country: string): string | null {
  if (!blocked.length) return null;
  const names = [...new Set(blocked.map((v) => nameOf(v) ?? "An item in a mystery box"))];
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} can’t ship to ${countryLabel(country)} from any of our warehouses. Remove ${names.length === 1 ? "it" : "them"} to check out the rest, or choose another country.`;
}

export function isShipCountry(code: string | null | undefined): code is string {
  return !!code && SHIP_COUNTRIES.some((c) => c.code === code);
}

export interface ShipItem {
  vid: string;
  quantity: number;
  inventoryJson: string | null;
  weightGrams?: number | null;
}

/** One customer-facing option. `method` is CJ's logistic name, kept server-side for placing the order. */
export interface ShipTier {
  key: "standard" | "express";
  label: string;
  cents: number;
  minDays: number | null;
  maxDays: number | null;
  method: string;
  fromCountry: string;
  /** Set when the order ships as several parcels; `method` is then "SPLIT". */
  parcels?: ParcelPlanEntry[];
}

function days(aging: string | undefined): [number | null, number | null] {
  const n = String(aging ?? "").match(/\d+/g)?.map(Number) ?? [];
  if (!n.length) return [null, null];
  return [Math.min(...n), Math.max(...n)];
}

export function parcelsLabel(t: Pick<ShipTier, "parcels">): string {
  return t.parcels && t.parcels.length > 1 ? `${t.parcels.length} parcels` : "";
}

export function daysLabel(t: Pick<ShipTier, "minDays" | "maxDays">): string {
  if (t.minDays == null) return "Delivery time confirmed at dispatch";
  return t.minDays === t.maxDays ? `${t.minDays} business days` : `${t.minDays}–${t.maxDays} business days`;
}

export interface CartQuote {
  tiers: ShipTier[];
  /** VIDs CJ won't ship even one unit of to this address, from any warehouse that stocks them. */
  blocked: string[];
}

const cache = new Map<string, { at: number; quote: CartQuote }>();
const TTL_MS = 30 * 60_000;

async function wholeOrderOptions(items: ShipItem[], from: string, country: string, zip?: string) {
  const env = await freightCalculate({
    startCountryCode: from,
    endCountryCode: country,
    zip: zip || undefined,
    products: items.map((i) => ({ vid: i.vid, quantity: i.quantity })),
  });
  return (env.data ?? [])
    .filter((o) => o.logisticName && Number.isFinite(Number(o.logisticPrice)))
    .map((o) => {
      const [minDays, maxDays] = days(o.logisticAging);
      return { method: o.logisticName, cents: Math.ceil(Number(o.logisticPrice) * 100), minDays, maxDays };
    })
    .sort((a, b) => a.cents - b.cents);
}

/** Standard and Express tiers for these items to this address; see quoteCart. */
export async function quoteTiers(items: ShipItem[], country: string, zip?: string): Promise<ShipTier[]> {
  return (await quoteCart(items, country, zip)).tiers;
}

/**
 * Standard (cheapest) and, when CJ has a faster method, Express, for these items to this address.
 * Tries the usual warehouse first (the US one for a US address it fully stocks, else China), then every
 * other warehouse that stocks it all, then splits the order into parcels that may ship from different
 * warehouses. When nothing works, `blocked` names the products that can't ship at all.
 */
export async function quoteCart(items: ShipItem[], country: string, zip?: string): Promise<CartQuote> {
  if (!items.length) return { tiers: [], blocked: [] };
  const key = JSON.stringify([items.map((i) => [i.vid, i.quantity]).sort(), country, (zip ?? "").slice(0, 3)]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.quote;

  const tiers: ShipTier[] = [];
  let blocked: string[] = [];
  for (const fromCountry of originCandidates(items, country)) {
    const options = await wholeOrderOptions(items, fromCountry, country, zip);
    const cheapest = options[0];
    if (!cheapest) continue;
    tiers.push({ key: "standard", label: "Standard", fromCountry, ...cheapest });
    const fastest = [...options].sort((a, b) => (a.maxDays ?? 999) - (b.maxDays ?? 999) || a.cents - b.cents)[0];
    if (fastest && fastest.method !== cheapest.method && (fastest.maxDays ?? 999) < (cheapest.maxDays ?? 999))
      tiers.push({ key: "express", label: "Express", fromCountry, ...fastest });
    break;
  }

  // Too heavy or big for one parcel, or no single warehouse can send it all: plan several CJ parcels.
  if (!tiers.length) {
    const fromCountry = chooseFromCountry(items, country);
    const planned = await planParcels(
      items.map((i) => ({ vid: i.vid, quantity: i.quantity, weightGrams: i.weightGrams, origins: originCandidates([{ quantity: 1, inventoryJson: i.inventoryJson }], country) })),
      fromCountry,
      country,
      zip,
    );
    blocked = planned.blocked;
    if (planned.parcels) {
      for (const [key, fast] of [["standard", false], ["express", true]] as const) {
        const plan = choosePlan(planned.parcels, fast);
        const cents = plan.reduce((n, e) => n + e.cents, 0);
        const w = planWindow(planned.parcels, plan);
        if (key === "express" && (w.maxDays ?? 999) >= (tiers[0]?.maxDays ?? 999)) continue;
        tiers.push({ key, label: key === "standard" ? "Standard" : "Express", cents, ...w, method: "SPLIT", fromCountry: plan[0]?.from ?? fromCountry, parcels: plan });
      }
    }
  }
  const quote = { tiers, blocked };
  cache.set(key, { at: Date.now(), quote });
  return quote;
}
