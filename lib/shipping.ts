// Customer shipping quotes: CJ's live freight price for the exact VIDs, passed through at cost.
// Method names are mapped to our own tiers (Standard / Express) so CJ's carrier names never reach the browser.

import { freightCalculate } from "@/lib/cj/client";
import { chooseFromCountry } from "@/lib/fulfillment";
import { choosePlan, planParcels, planWindow, type ParcelPlanEntry } from "@/lib/parcels";

export const SHIP_COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "CA", name: "Canada" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "IE", name: "Ireland" },
];

export function isShipCountry(code: string | null | undefined): code is string {
  return !!code && SHIP_COUNTRIES.some((c) => c.code === code);
}

export interface ShipItem {
  vid: string;
  quantity: number;
  inventoryJson: string | null;
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

const cache = new Map<string, { at: number; tiers: ShipTier[] }>();
const TTL_MS = 30 * 60_000;

/**
 * Standard (cheapest) and, when CJ has a faster method, Express, for these items to this address.
 * Ships from CJ's US warehouse when it stocks everything for a US address, else from China.
 */
export async function quoteTiers(items: ShipItem[], country: string, zip?: string): Promise<ShipTier[]> {
  if (!items.length) return [];
  const key = JSON.stringify([items.map((i) => [i.vid, i.quantity]).sort(), country, (zip ?? "").slice(0, 3)]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tiers;

  const fromCountry = chooseFromCountry(items, country);
  const env = await freightCalculate({
    startCountryCode: fromCountry,
    endCountryCode: country,
    zip: zip || undefined,
    products: items.map((i) => ({ vid: i.vid, quantity: i.quantity })),
  });
  const options = (env.data ?? [])
    .filter((o) => o.logisticName && Number.isFinite(Number(o.logisticPrice)))
    .map((o) => {
      const [minDays, maxDays] = days(o.logisticAging);
      return { method: o.logisticName, cents: Math.ceil(Number(o.logisticPrice) * 100), minDays, maxDays };
    })
    .sort((a, b) => a.cents - b.cents);

  const tiers: ShipTier[] = [];
  // Too heavy or big for one parcel: split it into several CJ parcels and quote each one.
  const units = items.reduce((n, i) => n + i.quantity, 0);
  if (!options.length && units > 1) {
    const planned = await planParcels(items.map((i) => ({ vid: i.vid, quantity: i.quantity })), fromCountry, country, zip);
    if (planned) {
      for (const [key, fast] of [["standard", false], ["express", true]] as const) {
        const plan = choosePlan(planned, fast);
        const cents = plan.reduce((n, e) => n + e.cents, 0);
        const w = planWindow(planned, plan);
        if (key === "express" && (w.maxDays ?? 999) >= (tiers[0]?.maxDays ?? 999)) continue;
        tiers.push({ key, label: key === "standard" ? "Standard" : "Express", cents, ...w, method: "SPLIT", fromCountry, parcels: plan });
      }
    }
  }
  const cheapest = options[0];
  if (cheapest) {
    tiers.push({ key: "standard", label: "Standard", fromCountry, ...cheapest });
    const fastest = [...options].sort((a, b) => (a.maxDays ?? 999) - (b.maxDays ?? 999) || a.cents - b.cents)[0];
    if (fastest && fastest.method !== cheapest.method && (fastest.maxDays ?? 999) < (cheapest.maxDays ?? 999))
      tiers.push({ key: "express", label: "Express", fromCountry, ...fastest });
  }
  cache.set(key, { at: Date.now(), tiers });
  return tiers;
}
