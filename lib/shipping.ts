// Customer shipping quotes: CJ's live freight price for the exact VIDs, passed through at cost.
// Method names are mapped to our own tiers (Standard / Express) so CJ's carrier names never reach the browser.

import { prisma } from "@/lib/db";
import { currentCjLane, withCjPriority, type CjLane } from "@/lib/cj/lanes";
import { processSingleton } from "@/lib/singleton";
import { SHIP_COUNTRIES } from "@/lib/countries";
import { chooseFromCountry, originCandidates } from "@/lib/fulfillment";
import { choosePlan, parcelOptions, planParcels, planWindow, type ParcelPlanEntry } from "@/lib/parcels";
import { SEA_METHOD, seaTier } from "@/lib/sea";

export { SHIP_COUNTRIES };

export function countryLabel(code: string): string {
  return SHIP_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

/** "X can’t ship to Canada…" naming the products that block a cart (VIDs → names via `nameOf`). */
export function blockedMessage(
  blocked: string[],
  nameOf: (vid: string) => string | undefined,
  country: string,
  /** True for items stocked only in the US warehouse (which ships to US addresses only). */
  usWarehouseOnly: (vid: string) => boolean = () => false,
): string | null {
  if (!blocked.length) return null;
  const listOf = (vids: string[]) => {
    const names = [...new Set(vids.map((v) => nameOf(v) ?? "An item in a mystery box"))];
    return { names, text: names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` };
  };
  const usOnly = country !== "US" ? blocked.filter(usWarehouseOnly) : [];
  const other = blocked.filter((v) => !usOnly.includes(v));
  const parts: string[] = [];
  if (usOnly.length) {
    const l = listOf(usOnly);
    parts.push(`${l.text} ${l.names.length === 1 ? "is" : "are"} in our US warehouse, which ships to US addresses only.`);
  }
  if (other.length) parts.push(`${listOf(other).text} can’t ship to ${countryLabel(country)} from any of our warehouses.`);
  const n = listOf(blocked).names.length;
  return `${parts.join(" ")} Remove ${n === 1 ? "it" : "them"} to check out the rest, or choose another country.`;
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

export function parcelsLabel(t: Pick<ShipTier, "parcels">): string {
  return t.parcels && t.parcels.length > 1 ? `${t.parcels.length} parcels` : "";
}

export function daysLabel(t: Pick<ShipTier, "minDays" | "maxDays"> & { method?: string }): string {
  if (t.method === SEA_METHOD) return "about 4–7 weeks by boat";
  if (t.minDays == null) return "Delivery time confirmed at dispatch";
  return t.minDays === t.maxDays ? `${t.minDays} business days` : `${t.minDays}–${t.maxDays} business days`;
}

export interface CartQuote {
  tiers: ShipTier[];
  /** VIDs CJ won't ship even one unit of to this address, from any warehouse that stocks them. */
  blocked: string[];
}

const cache = processSingleton("ship-quote-cache", () => new Map<string, { at: number; quote: CartQuote }>());
/** A quote this recent is used as is; checkout insists on one. */
export const FRESH_MS = 30 * 60_000;
/** Older quotes (up to this age) are still shown instantly while a fresh one is fetched in the background. */
const STALE_MS = 7 * 86_400_000;

function quoteKey(items: ShipItem[], country: string, zip?: string) {
  return JSON.stringify([items.map((i) => [i.vid, i.quantity]).sort(), country, (zip ?? "").slice(0, 3)]);
}

function totalGrams(items: ShipItem[]): number | null {
  return items.every((i) => (i.weightGrams ?? 0) > 0) ? Math.round(items.reduce((n, i) => n + i.weightGrams! * i.quantity, 0)) : null;
}

/** A remembered quote (memory, then database) no older than `maxAgeMs`, with its age. */
async function remembered(key: string, maxAgeMs: number): Promise<{ at: number; quote: CartQuote } | null> {
  const mem = cache.get(key);
  if (mem && Date.now() - mem.at < maxAgeMs) return mem;
  const row = await prisma.shippingQuote.findUnique({ where: { key } }).catch(() => null);
  if (!row || Date.now() - row.quotedAt.getTime() >= maxAgeMs) return null;
  const hit = { at: row.quotedAt.getTime(), quote: JSON.parse(row.json) as CartQuote };
  if (!mem || mem.at < hit.at) cache.set(key, hit);
  return hit;
}

/** CJ's methods for the whole order from one warehouse (remembered for a while: see parcelOptions). */
function wholeOrderOptions(items: ShipItem[], from: string, country: string, zip?: string) {
  return parcelOptions(from, country, zip, items.map((i) => ({ vid: i.vid, quantity: i.quantity })));
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
 *
 * Remembered quotes come back at once: a fresh one as is, an older one (up to a week, or `maxAgeMs`) while a
 * fresh one is fetched in the background. Pass `maxAgeMs: FRESH_MS` where the price will be charged.
 */
export async function quoteCart(items: ShipItem[], country: string, zip?: string, opts: { maxAgeMs?: number } = {}): Promise<CartQuote> {
  return withSea(await quoteCartByAir(items, country, zip, opts), items, country);
}

/**
 * Nothing CJ can send (big lithium batteries to Canada): offer the sea option from the merchant's rate card.
 * Added on every read rather than cached, so a rate change shows at once.
 */
async function withSea(quote: CartQuote, items: ShipItem[], country: string): Promise<CartQuote> {
  if (quote.tiers.length || !quote.blocked.length) return quote;
  const sea = await seaTier(items, country).catch(() => null);
  return sea ? { ...quote, tiers: [sea] } : quote;
}

async function quoteCartByAir(items: ShipItem[], country: string, zip?: string, opts: { maxAgeMs?: number } = {}): Promise<CartQuote> {
  if (!items.length) return { tiers: [], blocked: [] };
  const key = quoteKey(items, country, zip);
  const hit = await remembered(key, opts.maxAgeMs ?? STALE_MS);
  if (hit) {
    if (Date.now() - hit.at >= FRESH_MS) void withCjPriority("background", () => liveQuote(key, items, country, zip)).catch(() => null);
    return hit.quote;
  }
  return liveQuote(key, items, country, zip);
}

/** A remembered quote of any age up to a week, without ever calling CJ (for instant first paint). */
export async function peekQuote(items: ShipItem[], country: string, zip?: string): Promise<{ quote: CartQuote; fresh: boolean } | null> {
  if (!items.length) return null;
  const hit = await remembered(quoteKey(items, country, zip), STALE_MS);
  return hit ? { quote: await withSea(hit.quote, items, country), fresh: Date.now() - hit.at < FRESH_MS } : null;
}

/** Asks CJ (one request per cart at a time; a more urgent caller joins and raises its priority). */
function liveQuote(key: string, items: ShipItem[], country: string, zip?: string): Promise<CartQuote> {
  const caller = currentCjLane();
  const running = inflight.get(key);
  if (running) {
    running.lane.priority = Math.max(running.lane.priority, caller.priority);
    return running.promise;
  }
  const lane: CjLane = { priority: caller.priority };
  const promise = withCjPriority(lane, () => computeQuote(items, country, zip))
    .then(async (quote) => {
      const at = Date.now();
      cache.set(key, { at, quote });
      const data = { country, grams: totalGrams(items), json: JSON.stringify(quote), quotedAt: new Date(at) };
      await prisma.shippingQuote.upsert({ where: { key }, create: { key, ...data }, update: data }).catch(() => null);
      return quote;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, { lane, promise });
  return promise;
}

export interface ShipEstimate {
  cents: number;
  minDays: number | null;
  maxDays: number | null;
}

/**
 * A rough Standard price for a cart nobody has quoted yet, from earlier CJ quotes to the same country:
 * a straight line through (weight, price), never below the cheapest seen. Null without enough data.
 */
export async function estimateFromHistory(items: ShipItem[], country: string): Promise<ShipEstimate | null> {
  const grams = totalGrams(items);
  if (!grams) return null;
  const rows = await prisma.shippingQuote
    .findMany({ where: { country, grams: { not: null } }, orderBy: { quotedAt: "desc" }, take: 300, select: { grams: true, json: true } })
    .catch(() => []);
  const points = rows.flatMap((r) => {
    const std = (JSON.parse(r.json) as CartQuote).tiers.find((t) => t.key === "standard");
    return std && r.grams ? [{ g: r.grams, c: std.cents, min: std.minDays, max: std.maxDays }] : [];
  });
  return fitEstimate(points, grams);
}

/** Least-squares line through (grams, cents) points, evaluated at `grams`. Exported for tests. */
export function fitEstimate(points: Array<{ g: number; c: number; min: number | null; max: number | null }>, grams: number): ShipEstimate | null {
  if (!points.length) return null;
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const floor = Math.min(...points.map((p) => p.c));
  let cents: number;
  const n = points.length;
  const mg = points.reduce((s, p) => s + p.g, 0) / n;
  const mc = points.reduce((s, p) => s + p.c, 0) / n;
  const varG = points.reduce((s, p) => s + (p.g - mg) ** 2, 0);
  if (n >= 2 && varG > 0) {
    const slope = Math.max(0, points.reduce((s, p) => s + (p.g - mg) * (p.c - mc), 0) / varG);
    cents = mc + slope * (grams - mg);
  } else {
    // One weight seen: scale by weight, gently (shipping grows slower than weight).
    cents = mc * Math.sqrt(grams / mg);
  }
  return {
    cents: Math.max(floor, Math.round(cents)),
    minDays: median(points.map((p) => p.min).filter((x): x is number => x != null)),
    maxDays: median(points.map((p) => p.max).filter((x): x is number => x != null)),
  };
}

const inflight = processSingleton("ship-quote-inflight", () => new Map<string, { lane: CjLane; promise: Promise<CartQuote> }>());

async function computeQuote(items: ShipItem[], country: string, zip?: string): Promise<CartQuote> {
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
  return { tiers, blocked };
}
