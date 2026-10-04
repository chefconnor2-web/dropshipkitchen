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

export interface PlanLine {
  vid: string;
  quantity: number;
  /** Unit weight, for packing different products into shared parcels. */
  weightGrams?: number | null;
}

/** Binary-search refinement steps after halving finds a size CJ ships (a few more CJ calls, fewer parcels). */
const REFINE_STEPS = 4;

/**
 * Plans the fewest parcels CJ will ship:
 * 1. For each product, find the largest quantity CJ quotes in one parcel (halve until it ships, then
 *    binary-search back up between the size that shipped and the one that didn't).
 * 2. When every product has a weight, pack products together by weight (heaviest first), each parcel
 *    limited by the tightest product in it; any mixed parcel CJ won't quote is split back per product.
 * Returns null when even one unit of a product can't ship, or the plan needs more than MAX_PARCELS.
 */
export async function planParcels(items: PlanLine[], from: string, to: string, zip?: string): Promise<PlannedParcel[] | null> {
  const memo = new Map<string, Promise<ParcelOption[]>>();
  const quote = (parcel: Array<{ vid: string; quantity: number }>) => {
    const key = JSON.stringify([...parcel].sort((a, b) => a.vid.localeCompare(b.vid)));
    if (!memo.has(key)) memo.set(key, parcelOptions(from, to, zip, parcel).catch(() => []));
    return memo.get(key)!;
  };

  // 1. Largest single-product parcel per line.
  const limits = new Map<string, number>();
  for (const line of items) {
    if ((await quote([{ vid: line.vid, quantity: line.quantity }])).length) {
      limits.set(line.vid, line.quantity);
      continue;
    }
    let lo = 0;
    let hi = line.quantity;
    for (let size = Math.ceil(line.quantity / 2); size >= 1; size = size === 1 ? 0 : Math.ceil(size / 2)) {
      if ((await quote([{ vid: line.vid, quantity: size }])).length) {
        lo = size;
        break;
      }
      hi = size;
    }
    if (!lo) return null;
    for (let i = 0; i < REFINE_STEPS && hi - lo > 1; i++) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await quote([{ vid: line.vid, quantity: mid }])).length) lo = mid;
      else hi = mid;
    }
    limits.set(line.vid, lo);
  }

  // Single-product parcels: full parcels at the limit plus a remainder.
  const perLine = (line: PlanLine) => {
    const size = limits.get(line.vid)!;
    const out: Array<Array<{ vid: string; quantity: number }>> = [];
    for (let left = line.quantity; left > 0; left -= size) out.push([{ vid: line.vid, quantity: Math.min(size, left) }]);
    return out;
  };

  // 2. Pack by weight when we know every product's weight.
  let groups: Array<Array<{ vid: string; quantity: number }>>;
  const weighed = items.length > 1 && items.every((l) => (l.weightGrams ?? 0) > 0);
  if (weighed) {
    type Bin = { items: Map<string, number>; grams: number; cap: number };
    const bins: Bin[] = [];
    for (const line of [...items].sort((a, b) => b.weightGrams! - a.weightGrams!)) {
      const w = line.weightGrams!;
      // A product that shipped whole has no known limit of its own; the other products' limits and CJ's quote decide.
      const capLine = limits.get(line.vid)! >= line.quantity ? Infinity : limits.get(line.vid)! * w;
      let left = line.quantity;
      for (const bin of bins) {
        if (!left) break;
        const room = Math.floor((Math.min(bin.cap, capLine) - bin.grams) / w);
        const n = Math.min(left, room);
        if (n <= 0) continue;
        bin.items.set(line.vid, (bin.items.get(line.vid) ?? 0) + n);
        bin.grams += n * w;
        bin.cap = Math.min(bin.cap, capLine);
        left -= n;
      }
      while (left > 0) {
        const n = Math.min(left, limits.get(line.vid)!);
        bins.push({ items: new Map([[line.vid, n]]), grams: n * w, cap: Number.isFinite(capLine) ? capLine : Math.max(n * w, ...bins.map((b) => b.cap).filter(Number.isFinite)) });
        left -= n;
      }
    }
    groups = bins.map((b) => [...b.items].map(([vid, quantity]) => ({ vid, quantity })));
  } else {
    groups = items.flatMap(perLine);
  }
  if (groups.length > MAX_PARCELS) return null;

  const parcels: PlannedParcel[] = [];
  for (const g of groups) {
    const options = await quote(g);
    if (options.length) {
      parcels.push({ items: g, options });
      continue;
    }
    // CJ won't take this mix together (e.g. a battery item with normal goods): ship its products separately.
    for (const part of g) {
      for (const single of perLine(part)) {
        const o = await quote(single);
        if (!o.length) return null;
        parcels.push({ items: single, options: o });
      }
    }
  }
  return parcels.length > MAX_PARCELS ? null : parcels;
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
