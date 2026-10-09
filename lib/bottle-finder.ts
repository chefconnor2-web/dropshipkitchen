// Admin bottle finder: real drinkware from CJ's live catalog (product/listV2), grouped by the styles people buy
// now, so the merchant can pick the gift bottle from actual products and photos and import it in one click.
// Several searches per style; results are deduped, filtered to things that are actually drinkware, and kept for
// half an hour so flipping between styles doesn't hit CJ again. Only listings whose photo shows one bottle we can
// print the logo onto (lib/bottle-mockup.ts) are kept, so every card is a real preview on the real product.

import { listProductsV2 } from "@/lib/cj/client";
import { parseListV2, type SearchResult } from "@/lib/cj/normalize";
import { blockedListing, rememberImage } from "@/lib/catalog-search";
import { processSingleton } from "@/lib/singleton";
import { analyseBottle } from "@/lib/bottle-mockup";

export const BOTTLE_TYPES = [
  { id: "tumbler", name: "40 oz tumbler", queries: ["40oz tumbler with handle", "stainless tumbler handle straw"] },
  { id: "flip", name: "Flip-straw bottle", queries: ["water bottle flip straw lid", "insulated water bottle straw"] },
  { id: "wide", name: "Wide-mouth bottle", queries: ["wide mouth insulated water bottle", "stainless steel vacuum water bottle"] },
  { id: "glasscan", name: "Glass can cup", queries: ["glass can cup bamboo lid straw", "beer can glass cup"] },
  { id: "mug", name: "Travel mug", queries: ["travel coffee mug", "insulated coffee tumbler lid"] },
  { id: "slim", name: "Slim sport bottle", queries: ["aluminum sports water bottle", "sports water bottle"] },
  { id: "custom", name: "Print-on-demand", queries: ["custom logo water bottle", "custom tumbler print", "personalized water bottle"] },
] as const;
export type BottleType = (typeof BOTTLE_TYPES)[number]["id"];

const DRINKWARE = /\b(bottle|tumbler|cup|mug|flask|can|thermos|jug|sipper)s?\b/i;
const CUSTOM = /\b(custom|customi[sz]ed|personali[sz]ed|diy|logo|print|engrav\w*|sublimation)\b/i;

export interface FoundBottle extends SearchResult {
  /** The listing mentions custom printing or logos (a hint, not a guarantee CJ prints it). */
  printable: boolean;
}

const cache = processSingleton("bottle-finder", () => new Map<string, { at: number; items: FoundBottle[] }>());
const TTL_MS = 30 * 60_000;

export async function findBottles(type: BottleType): Promise<FoundBottle[]> {
  const t = BOTTLE_TYPES.find((x) => x.id === type) ?? BOTTLE_TYPES[0];
  const hit = cache.get(t.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;
  const pages = await Promise.all(t.queries.map((q) => listProductsV2(q, 1, 40).then((env) => parseListV2(env.data).items)));
  const seen = new Set<string>();
  let items: FoundBottle[] = [];
  for (const r of pages.flat()) {
    if (seen.has(r.pid) || !DRINKWARE.test(r.name) || blockedListing(r.name) || !r.image) continue;
    seen.add(r.pid);
    rememberImage(r.pid, r.image);
    items.push({ ...r, printable: CUSTOM.test(r.name) || !!r.pod });
  }
  // Measure each photo (a few at a time) and keep only the ones the logo can be printed onto.
  const fits = new Map<string, boolean>();
  for (let i = 0; i < items.length; i += 6)
    await Promise.all(items.slice(i, i + 6).map(async (b) => fits.set(b.pid, await analyseBottle(b.pid, b.image!).catch(() => false))));
  items = items.filter((b) => fits.get(b.pid));
  // Printable listings first, then the ones more stores sell (a fair sign they ship well).
  items.sort((a, b) => Number(b.printable) - Number(a.printable) || (b.listedNum ?? 0) - (a.listedNum ?? 0));
  cache.set(t.id, { at: Date.now(), items });
  return items;
}
