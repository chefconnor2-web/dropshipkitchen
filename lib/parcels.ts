// Split shipments: when CJ has no parcel method for a whole order (too heavy or too big), find the largest
// quantity per parcel that CJ will ship for each line, and plan the order as several parcels, each quoted live.
// Checkout charges the parcels' total; approval places one CJ order per parcel.

import { freightCalculate } from "@/lib/cj/client";
import { processSingleton } from "@/lib/singleton";

export interface ParcelOption {
  method: string;
  cents: number;
  minDays: number | null;
  maxDays: number | null;
}
export interface PlannedParcel {
  items: Array<{ vid: string; quantity: number }>;
  options: ParcelOption[];
  /** Warehouse country this parcel ships from. */
  from: string;
}
/** What gets stored on an order: one chosen method per parcel. */
export interface ParcelPlanEntry {
  items: Array<{ vid: string; quantity: number }>;
  method: string;
  cents: number;
  /** Warehouse country; missing on plans made before parcels could ship from different warehouses. */
  from?: string;
}

/** A plan, or why there is none: the products CJ won't ship one unit of from any warehouse tried. */
export interface PlanResult {
  parcels: PlannedParcel[] | null;
  blocked: string[];
}

export const MAX_PARCELS = 30;

function days(aging: string | undefined): [number | null, number | null] {
  const n = String(aging ?? "").match(/\d+/g)?.map(Number) ?? [];
  return n.length ? [Math.min(...n), Math.max(...n)] : [null, null];
}

/** CJ's answers are remembered this long, so a changed quantity or a re-quote only asks about what's new. */
const FREIGHT_TTL_MS = 30 * 60_000;
const FREIGHT_MEMO_MAX = 5000;
const freightMemo = processSingleton("cj-freight-memo", () => new Map<string, { at: number; options: Promise<ParcelOption[]> }>());

/** CJ's methods for these exact items from one warehouse, cheapest first (also shares a call already running). */
export function parcelOptions(from: string, to: string, zip: string | undefined, items: Array<{ vid: string; quantity: number }>): Promise<ParcelOption[]> {
  const key = JSON.stringify([from, to, zip || "", [...items].sort((a, b) => a.vid.localeCompare(b.vid)).map((i) => [i.vid, i.quantity])]);
  const hit = freightMemo.get(key);
  if (hit && Date.now() - hit.at < FREIGHT_TTL_MS) return hit.options;
  const options = askCj(from, to, zip, items);
  freightMemo.delete(key);
  freightMemo.set(key, { at: Date.now(), options });
  if (freightMemo.size > FREIGHT_MEMO_MAX) freightMemo.delete(freightMemo.keys().next().value!);
  // A failed call isn't an answer: forget it so the next quote asks again.
  options.catch(() => {
    if (freightMemo.get(key)?.options === options) freightMemo.delete(key);
  });
  return options;
}

async function askCj(from: string, to: string, zip: string | undefined, items: Array<{ vid: string; quantity: number }>): Promise<ParcelOption[]> {
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
  /** Warehouse countries to try for this product, best first. Defaults to the plan's `from`. */
  origins?: string[];
}

/** What CJ has said about one product alone in a parcel on one route: the most it shipped, the least it refused. */
export interface ParcelLimitKnowledge {
  get(key: string): { ok: number; fail: number; at: number } | undefined;
  set(key: string, v: { ok: number; fail: number; at: number }): unknown;
}
const LIMIT_TTL_MS = 30 * 60_000;
const sharedLimits = processSingleton("cj-parcel-limits", () => new Map<string, { ok: number; fail: number; at: number }>());

/** Binary-search refinement steps after halving finds a size CJ ships (a few more CJ calls, fewer parcels). */
const REFINE_STEPS = 4;

/**
 * Plans the fewest parcels CJ will ship:
 * 1. For each product, find the largest quantity CJ quotes in one parcel (halve until it ships, then
 *    binary-search back up between the size that shipped and the one that didn't).
 * 2. When every product has a weight, pack products together by weight (heaviest first), each parcel
 *    limited by the tightest product in it; any mixed parcel CJ won't quote is split back per product.
 * Each product ships from the first of its warehouses where CJ quotes one unit; products only share a
 * parcel with products from the same warehouse. No plan when a product can't ship from any warehouse
 * (those are listed in `blocked`) or the plan needs more than MAX_PARCELS.
 */
export async function planParcels(
  items: PlanLine[],
  from: string,
  to: string,
  zip?: string,
  quoter: typeof parcelOptions = parcelOptions,
  limits: ParcelLimitKnowledge = quoter === parcelOptions ? sharedLimits : new Map(),
): Promise<PlanResult> {
  const memo = new Map<string, Promise<ParcelOption[]>>();
  const originOf = new Map<string, string>();
  const limitKey = (origin: string, vid: string) => `${origin}|${to}|${vid}`;
  const known = (origin: string, vid: string) => {
    const k = limits.get(limitKey(origin, vid));
    return k && Date.now() - k.at < LIMIT_TTL_MS ? k : { ok: 0, fail: Infinity, at: 0 };
  };
  const quoteFrom = (origin: string, parcel: Array<{ vid: string; quantity: number }>) => {
    const key = JSON.stringify([origin, [...parcel].sort((a, b) => a.vid.localeCompare(b.vid))]);
    if (!memo.has(key)) {
      const asked = quoter(origin, to, zip, parcel);
      memo.set(key, asked.catch(() => []));
      // Remember single-product answers (not failed calls) so later quotes of this product skip the search.
      if (parcel.length === 1)
        asked.then(
          (o) => {
            const k = known(origin, parcel[0].vid);
            const q = parcel[0].quantity;
            limits.set(limitKey(origin, parcel[0].vid), o.length ? { ok: Math.max(k.ok, q), fail: Math.max(k.fail, q + 1), at: Date.now() } : { ok: Math.min(k.ok, q - 1), fail: Math.min(k.fail, q), at: Date.now() });
          },
          () => undefined,
        );
    }
    return memo.get(key)!;
  };
  const quote = (parcel: Array<{ vid: string; quantity: number }>) => quoteFrom(originOf.get(parcel[0].vid) ?? from, parcel);

  // 0. Where each product can ship from: the first warehouse CJ quotes one unit from. Check every product,
  // so the shopper hears about all the blockers at once.
  // Products are checked side by side (CJ calls overlap); each tries its warehouses in order.
  const origins = await Promise.all(
    items.map(async (line) => {
      for (const origin of line.origins?.length ? line.origins : [from]) if ((await quoteFrom(origin, [{ vid: line.vid, quantity: 1 }])).length) return origin;
      return undefined;
    }),
  );
  const blocked: string[] = [];
  items.forEach((line, i) => (origins[i] ? originOf.set(line.vid, origins[i]) : blocked.push(line.vid)));
  if (blocked.length) return { parcels: null, blocked };

  // 1. Largest single-product parcel per line.
  const sizes = new Map<string, number>();
  const found = await Promise.all(items.map((line) => largestParcel(line, quote, known(originOf.get(line.vid)!, line.vid))));
  for (const [i, line] of items.entries()) {
    if (!found[i]) return { parcels: null, blocked: [line.vid] };
    sizes.set(line.vid, found[i]);
  }

  // Single-product parcels: full parcels at the limit plus a remainder.
  const perLine = (line: PlanLine) => {
    const size = sizes.get(line.vid)!;
    const out: Array<Array<{ vid: string; quantity: number }>> = [];
    for (let left = line.quantity; left > 0; left -= size) out.push([{ vid: line.vid, quantity: Math.min(size, left) }]);
    return out;
  };

  // 2. Pack by weight when we know every product's weight.
  let groups: Array<Array<{ vid: string; quantity: number }>>;
  const weighed = items.length > 1 && items.every((l) => (l.weightGrams ?? 0) > 0);
  if (weighed) {
    type Bin = { items: Map<string, number>; grams: number; cap: number; from: string };
    const bins: Bin[] = [];
    for (const line of [...items].sort((a, b) => b.weightGrams! - a.weightGrams!)) {
      const w = line.weightGrams!;
      // A product that shipped whole has no known limit of its own; the other products' limits and CJ's quote decide.
      const capLine = sizes.get(line.vid)! >= line.quantity ? Infinity : sizes.get(line.vid)! * w;
      let left = line.quantity;
      const origin = originOf.get(line.vid)!;
      for (const bin of bins) {
        if (!left) break;
        if (bin.from !== origin) continue;
        const room = Math.floor((Math.min(bin.cap, capLine) - bin.grams) / w);
        const n = Math.min(left, room);
        if (n <= 0) continue;
        bin.items.set(line.vid, (bin.items.get(line.vid) ?? 0) + n);
        bin.grams += n * w;
        bin.cap = Math.min(bin.cap, capLine);
        left -= n;
      }
      while (left > 0) {
        const n = Math.min(left, sizes.get(line.vid)!);
        bins.push({ items: new Map([[line.vid, n]]), grams: n * w, cap: Number.isFinite(capLine) ? capLine : Math.max(n * w, ...bins.map((b) => b.cap).filter(Number.isFinite)), from: origin });
        left -= n;
      }
    }
    groups = bins.map((b) => [...b.items].map(([vid, quantity]) => ({ vid, quantity })));
  } else {
    groups = items.flatMap(perLine);
  }
  if (groups.length > MAX_PARCELS) return { parcels: null, blocked: [] };

  const parcels: PlannedParcel[] = [];
  const groupOptions = await Promise.all(groups.map((g) => quote(g)));
  for (const [gi, g] of groups.entries()) {
    const options = groupOptions[gi];
    if (options.length) {
      parcels.push({ items: g, options, from: originOf.get(g[0].vid)! });
      continue;
    }
    // CJ won't take this mix together (e.g. a battery item with normal goods): ship its products separately.
    for (const part of g) {
      for (const single of perLine(part)) {
        const o = await quote(single);
        if (!o.length) return { parcels: null, blocked: [part.vid] };
        parcels.push({ items: single, options: o, from: originOf.get(part.vid)! });
      }
    }
  }
  return { parcels: parcels.length > MAX_PARCELS ? null : parcels, blocked: [] };
}

/**
 * The largest quantity of one product CJ quotes in a single parcel (0 if not even one): halve until it
 * ships, then binary-search back up between the size that shipped and the one that didn't.
 */
async function largestParcel(
  line: PlanLine,
  quote: (parcel: Array<{ vid: string; quantity: number }>) => Promise<ParcelOption[]>,
  known: { ok: number; fail: number },
): Promise<number> {
  // Earlier answers for this product on this route can settle it without asking CJ again.
  if (known.ok >= line.quantity) return line.quantity;
  let lo = known.ok;
  let hi = Math.min(known.fail, line.quantity + 1);
  if (hi > line.quantity) {
    if ((await quote([{ vid: line.vid, quantity: line.quantity }])).length) return line.quantity;
    hi = line.quantity;
  }
  // Halve down from the size that failed until one ships (sizes at or below a known-good one need no call).
  for (let size = Math.ceil(hi / 2); size > lo; size = size === 1 ? 0 : Math.ceil(size / 2)) {
    if ((await quote([{ vid: line.vid, quantity: size }])).length) {
      lo = size;
      break;
    }
    hi = size;
  }
  for (let i = 0; lo && i < REFINE_STEPS && hi - lo > 1; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await quote([{ vid: line.vid, quantity: mid }])).length) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Cheapest method per parcel, or the fastest when `fast` (falls back to cheapest). */
export function choosePlan(parcels: PlannedParcel[], fast = false): ParcelPlanEntry[] {
  return parcels.map((p) => {
    const o = fast ? [...p.options].sort((a, b) => (a.maxDays ?? 999) - (b.maxDays ?? 999) || a.cents - b.cents)[0] : p.options[0];
    return { items: p.items, method: o.method, cents: o.cents, from: p.from };
  });
}

export function planWindow(parcels: PlannedParcel[], plan: ParcelPlanEntry[]): { minDays: number | null; maxDays: number | null } {
  const picked = plan.map((e, i) => parcels[i].options.find((o) => o.method === e.method)!);
  const mins = picked.map((o) => o.minDays).filter((x): x is number => x != null);
  const maxs = picked.map((o) => o.maxDays).filter((x): x is number => x != null);
  return { minDays: mins.length ? Math.max(...mins) : null, maxDays: maxs.length ? Math.max(...maxs) : null };
}
