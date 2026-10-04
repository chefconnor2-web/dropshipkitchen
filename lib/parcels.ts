// Split shipments: when CJ has no parcel method for a whole order (too heavy or too big), find the largest
// quantity per parcel that CJ will ship for each line, and plan the order as several parcels, each quoted live.
// Checkout charges the parcels' total; approval places one CJ order per parcel.

import { freightCalculate } from "@/lib/cj/client";

export interface ParcelOption {
  method: string;
  cents: number;
  minDays: number | null;
  maxDays: number | null;
}
export interface PlannedParcel {
  items: Array<{ vid: string; quantity: number }>;
  options: ParcelOption[];
}
/** What gets stored on an order: one chosen method per parcel. */
export interface ParcelPlanEntry {
  items: Array<{ vid: string; quantity: number }>;
  method: string;
  cents: number;
}

export const MAX_PARCELS = 30;

function days(aging: string | undefined): [number | null, number | null] {
  const n = String(aging ?? "").match(/\d+/g)?.map(Number) ?? [];
  return n.length ? [Math.min(...n), Math.max(...n)] : [null, null];
}

export async function parcelOptions(from: string, to: string, zip: string | undefined, items: Array<{ vid: string; quantity: number }>): Promise<ParcelOption[]> {
  const env = await freightCalculate({ startCountryCode: from, endCountryCode: to, zip: zip || undefined, products: items });
  return (env.data ?? [])
    .filter((o) => o.logisticName && Number.isFinite(Number(o.logisticPrice)))
    .map((o) => {
      const [minDays, maxDays] = days(o.logisticAging);
      return { method: o.logisticName, cents: Math.ceil(Number(o.logisticPrice) * 100), minDays, maxDays };
    })
    .sort((a, b) => a.cents - b.cents);
}

/**
 * Plans parcels line by line: halve the quantity until CJ quotes it, then send full parcels of that size plus a
 * remainder. Returns null when even one unit of a line can't ship, or the plan needs more than MAX_PARCELS.
 */
export async function planParcels(items: Array<{ vid: string; quantity: number }>, from: string, to: string, zip?: string): Promise<PlannedParcel[] | null> {
  const parcels: PlannedParcel[] = [];
  for (const line of items) {
    let size = line.quantity;
    let opts = await parcelOptions(from, to, zip, [{ vid: line.vid, quantity: size }]);
    while (!opts.length && size > 1) {
      size = Math.ceil(size / 2);
      opts = await parcelOptions(from, to, zip, [{ vid: line.vid, quantity: size }]);
    }
    if (!opts.length) return null;
    const full = Math.floor(line.quantity / size);
    const rest = line.quantity - full * size;
    if (full + (rest ? 1 : 0) + parcels.length > MAX_PARCELS) return null;
    for (let i = 0; i < full; i++) parcels.push({ items: [{ vid: line.vid, quantity: size }], options: opts });
    if (rest) {
      const restOpts = await parcelOptions(from, to, zip, [{ vid: line.vid, quantity: rest }]);
      if (!restOpts.length) return null;
      parcels.push({ items: [{ vid: line.vid, quantity: rest }], options: restOpts });
    }
  }
  return parcels;
}

/** Cheapest method per parcel, or the fastest when `fast` (falls back to cheapest). */
export function choosePlan(parcels: PlannedParcel[], fast = false): ParcelPlanEntry[] {
  return parcels.map((p) => {
    const o = fast ? [...p.options].sort((a, b) => (a.maxDays ?? 999) - (b.maxDays ?? 999) || a.cents - b.cents)[0] : p.options[0];
    return { items: p.items, method: o.method, cents: o.cents };
  });
}

export function planWindow(parcels: PlannedParcel[], plan: ParcelPlanEntry[]): { minDays: number | null; maxDays: number | null } {
  const picked = plan.map((e, i) => parcels[i].options.find((o) => o.method === e.method)!);
  const mins = picked.map((o) => o.minDays).filter((x): x is number => x != null);
  const maxs = picked.map((o) => o.maxDays).filter((x): x is number => x != null);
  return { minDays: mins.length ? Math.max(...mins) : null, maxDays: maxs.length ? Math.max(...maxs) : null };
}
