// Storefront search over CJ's whole live catalog. Results are customer-safe: our title, our price
// (store rule on CJ's cost) and an image served through our own origin. Never CJ ids or URLs beyond the PID.

import { listProductsV2 } from "@/lib/cj/client";
import { parseListV2, suggestTitle } from "@/lib/cj/normalize";
import { retailCents } from "@/lib/money";
import { processSingleton } from "@/lib/singleton";

/** Listings we won't sell: brand names that are almost always counterfeit on wholesale sites, and restricted goods. */
const BLOCKED =
  /\b(nike|adidas|gucci|louis\s?vuitton|chanel|rolex|prada|dior|hermes|supreme|yeezy|jordan|balenciaga|versace|fendi|cartier|disney|marvel|pokemon|hello\s?kitty|apple\s?watch|airpods|beats|vape|e-?cig\w*|cigarette|nicotine|tobacco|cbd|thc|weed|cannabis|gun|pistol|rifle|airsoft|ammo|taser|stun\s?gun|pepper\s?spray|brass\s?knuckle|switchblade|sex|sexy|erotic|adult\s?toy|dildo|vibrator|lingerie|drug|pill|medicine|steroid|knockoff|replica)\b/i;

export function blockedListing(name: string): boolean {
  return BLOCKED.test(name);
}

export interface CatalogHit {
  pid: string;
  title: string;
  fromCents: number;
}

const resultCache = processSingleton("catalog-results", () => new Map<string, { at: number; hits: CatalogHit[]; total: number | null }>());
const imageByPid = processSingleton("catalog-images", () => new Map<string, string>());
// Search results change slowly; prices are re-checked live when a product is opened and at checkout.
const TTL_MS = 60 * 60_000;
const MAX_IMAGES = 5000;

export const PAGE_SIZE = 24;

export async function searchCatalog(q: string, page: number): Promise<{ hits: CatalogHit[]; total: number | null }> {
  const key = `${q.toLowerCase()}|${page}`;
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const { items, total } = parseListV2((await listProductsV2(q, page, PAGE_SIZE)).data);
  const hits: CatalogHit[] = [];
  for (const r of items) {
    if (r.priceCents == null || r.priceCents <= 0 || blockedListing(r.name)) continue;
    if (r.image) {
      if (imageByPid.size >= MAX_IMAGES) imageByPid.delete(imageByPid.keys().next().value!);
      imageByPid.set(r.pid, r.image);
    }
    hits.push({ pid: r.pid, title: suggestTitle(r.name), fromCents: retailCents(r.priceCents) });
  }
  const out = { at: Date.now(), hits, total };
  resultCache.set(key, out);
  if (resultCache.size > 500) resultCache.delete(resultCache.keys().next().value!);
  return out;
}

/** The image for a PID this server has shown in search results (no open proxy). */
export function searchImage(pid: string): string | undefined {
  return imageByPid.get(pid);
}
