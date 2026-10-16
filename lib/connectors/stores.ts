// Other stores, by cart link. Neon finds a product on the store's own site (web_search / web_fetch), and
// store_cart reads that page on our server to learn how the store works: its platform, the exact option and its
// price. It then builds the store's own add-to-cart link. The shopper opens the link in their own browser, so the
// items land in their own cart on that store, and they check out there. Nothing is bought here, and no passwords,
// addresses or cards are ever typed.
//
// Platforms:
//   Shopify      /products/<handle>.js gives every option with its price; one link fills the whole cart:
//                https://store/cart/<variant>:<qty>,<variant>:<qty>
//   WooCommerce  ?add-to-cart=<id>&quantity=<n>: one link per product (simple products only)
//   BigCommerce  /cart.php?action=add&product_id=<id>&qty=<n>: one link per product
//   Anything else: the product page itself, priced from its schema.org data, added by hand.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import type { StoreCartCard } from "@/lib/flights-shared";
import type { Connector, ConnectorContext, ToolResult } from "./types";

export type Platform = "shopify" | "woocommerce" | "bigcommerce" | "other";

export interface StoreLine {
  url: string;
  title: string;
  option?: string;
  quantity: number;
  /** Unit price in the store's currency, in cents (null when the page doesn't say). */
  priceCents: number | null;
  currency: string | null;
  available: boolean | null;
  /** Shopify variant or WooCommerce/BigCommerce product id. */
  id: string | null;
  /** Other options the product has, when the requested one wasn't found or none was given. */
  options?: string[];
  note?: string;
}

export interface StoreCart {
  store: string;
  platform: Platform;
  lines: StoreLine[];
  /** One link fills the whole cart (Shopify); otherwise one link per product, opened in turn. */
  links: Array<{ label: string; url: string }>;
  subtotalCents: number | null;
  currency: string | null;
}

/* ---------- Pure helpers (unit-tested in tests/store-carts.test.ts) ---------- */

/** Private, loopback, link-local and other non-public addresses: never fetched. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** The platform a product page runs on, from its HTML. */
export function detectPlatform(html: string): Platform {
  if (/cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(html)) return "shopify";
  if (/woocommerce|wp-content\/plugins\/woocommerce/i.test(html)) return "woocommerce";
  if (/bigcommerce\.com|BCData|stencil-utils/i.test(html)) return "bigcommerce";
  return "other";
}

/** Shopify's product handle from a product URL (/products/<handle>, also under /collections/…). */
export function shopifyHandle(url: URL): string | null {
  const m = url.pathname.match(/\/products\/([^/?#.]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

/** The option matching every word the shopper asked for, else the only one, else null (ask which). */
export function pickOption<T extends { title: string }>(options: T[], want?: string): T | null {
  if (options.length === 1) return options[0];
  if (!want?.trim()) return null;
  const w = words(want);
  return options.find((o) => w.every((x) => words(o.title).includes(x))) ?? options.find((o) => o.title.toLowerCase() === want.toLowerCase()) ?? null;
}

/** schema.org Product data from a page's JSON-LD: name, price and currency of the first offer, availability. */
export function jsonLdProduct(html: string): { name?: string; priceCents?: number; currency?: string; available?: boolean; sku?: string } | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const nodes: unknown[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        nodes.push(n);
        const g = (n as { "@graph"?: unknown })["@graph"];
        if (g) walk(g);
      }
    };
    walk(data);
    for (const n of nodes as Array<Record<string, unknown>>) {
      const t = n["@type"];
      if (!(t === "Product" || (Array.isArray(t) && t.includes("Product")))) continue;
      const offers = n.offers as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
      const offer = Array.isArray(offers) ? offers[0] : offers;
      const price = Number(offer?.price ?? offer?.lowPrice);
      return {
        name: typeof n.name === "string" ? n.name : undefined,
        priceCents: Number.isFinite(price) ? Math.round(price * 100) : undefined,
        currency: typeof offer?.priceCurrency === "string" ? offer.priceCurrency : undefined,
        available: typeof offer?.availability === "string" ? !/OutOfStock|Discontinued|SoldOut/i.test(offer.availability) : undefined,
        sku: typeof n.sku === "string" ? n.sku : undefined,
      };
    }
  }
  return null;
}

/** WooCommerce simple product id (the add-to-cart button's value). Null for variable products. */
export function wooProductId(html: string): string | null {
  if (/variations_form/.test(html)) return null;
  return html.match(/name=["']add-to-cart["'][^>]*value=["'](\d+)["']/i)?.[1] ?? html.match(/value=["'](\d+)["'][^>]*name=["']add-to-cart["']/i)?.[1] ?? null;
}

/** BigCommerce product id (the add-to-cart form's hidden product_id). */
export function bigcommerceProductId(html: string): string | null {
  return html.match(/name=["']product_id["'][^>]*value=["'](\d+)["']/i)?.[1] ?? html.match(/value=["'](\d+)["'][^>]*name=["']product_id["']/i)?.[1] ?? null;
}

const clampQty = (q: unknown) => Math.min(999, Math.max(1, Math.floor(Number(q) || 1)));

/** The store's own cart link(s) for resolved lines. */
export function cartLinks(origin: string, platform: Platform, lines: StoreLine[]): Array<{ label: string; url: string }> {
  const ready = lines.filter((l) => l.id);
  if (platform === "shopify") {
    if (!ready.length) return [];
    return [{ label: "Open cart", url: `${origin}/cart/${ready.map((l) => `${l.id}:${clampQty(l.quantity)}`).join(",")}` }];
  }
  if (platform === "woocommerce") return ready.map((l) => ({ label: `Add ${l.title}`, url: `${origin}/?add-to-cart=${l.id}&quantity=${clampQty(l.quantity)}` }));
  if (platform === "bigcommerce") return ready.map((l) => ({ label: `Add ${l.title}`, url: `${origin}/cart.php?action=add&product_id=${l.id}&qty=${clampQty(l.quantity)}` }));
  return [];
}

export function subtotal(lines: StoreLine[]): { cents: number | null; currency: string | null } {
  if (!lines.length || lines.some((l) => l.priceCents == null)) return { cents: null, currency: lines[0]?.currency ?? null };
  const currencies = new Set(lines.map((l) => l.currency));
  if (currencies.size > 1) return { cents: null, currency: null };
  return { cents: lines.reduce((n, l) => n + l.priceCents! * clampQty(l.quantity), 0), currency: lines[0].currency };
}

export const money = (cents: number | null, currency: string | null) =>
  cents == null ? "price on the store's page" : `${currency ?? ""} ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();

/* ---------- Fetching store pages, public addresses only ---------- */

const UA = "Mozilla/5.0 (compatible; ChitCartBuilder/1.0; +https://chit.app)";
const MAX_BYTES = 3_000_000;

async function assertPublic(url: URL) {
  if (url.protocol !== "https:") throw new Error("Only https store pages can be read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error("That address isn't a public store.");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!ips.length || ips.some(isPrivateAddress)) throw new Error("That address isn't a public store.");
}

/** GETs a public https page (redirects re-checked, 10 s, 3 MB). */
export async function storeFetch(raw: string, accept = "text/html,application/json"): Promise<{ url: URL; status: number; body: string }> {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": UA, accept }, signal: AbortSignal.timeout(10_000) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url);
      continue;
    }
    const reader = res.body?.getReader();
    let body = "";
    if (reader) {
      const dec = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        body += dec.decode(value, { stream: true });
      }
    }
    return { url, status: res.status, body };
  }
  throw new Error("Too many redirects.");
}

/* ---------- Reading one product ---------- */

interface ShopifyProduct {
  title: string;
  variants: Array<{ id: number; title: string; price: number; available: boolean }>;
}

async function shopifyCurrency(origin: string): Promise<string | null> {
  try {
    const r = await storeFetch(`${origin}/cart.js`, "application/json");
    return (JSON.parse(r.body) as { currency?: string }).currency ?? null;
  } catch {
    return null;
  }
}

/** Reads a product page and resolves the line: platform, option, id and price. */
export async function resolveProduct(raw: string, quantity: number, option?: string): Promise<{ origin: string; platform: Platform; line: StoreLine }> {
  const page = await storeFetch(raw);
  const origin = page.url.origin;
  const base: StoreLine = { url: page.url.toString(), title: page.url.pathname, quantity: clampQty(quantity), priceCents: null, currency: null, available: null, id: null };
  if (page.status >= 400) return { origin, platform: "other", line: { ...base, note: `The page answered ${page.status}.` } };
  const platform = detectPlatform(page.body);
  const ld = jsonLdProduct(page.body);
  const line: StoreLine = { ...base, title: ld?.name ?? base.title, priceCents: ld?.priceCents ?? null, currency: ld?.currency ?? null, available: ld?.available ?? null };

  if (platform === "shopify") {
    const handle = shopifyHandle(page.url);
    if (handle) {
      try {
        const p = JSON.parse((await storeFetch(`${origin}/products/${encodeURIComponent(handle)}.js`, "application/json")).body) as ShopifyProduct;
        const variants = p.variants.map((v) => ({ ...v, title: v.title === "Default Title" ? p.title : v.title }));
        const v = pickOption(variants, option);
        const currency = (await shopifyCurrency(origin)) ?? line.currency;
        if (!v) return { origin, platform, line: { ...line, title: p.title, currency, options: variants.map((x) => x.title), note: "Pick one of these options." } };
        return { origin, platform, line: { ...line, title: p.title, option: v.title === p.title ? undefined : v.title, id: String(v.id), priceCents: v.price, currency, available: v.available } };
      } catch {
        // Fall through: priced from the page, added by hand.
      }
    }
  }
  if (platform === "woocommerce") {
    const id = wooProductId(page.body);
    return { origin, platform, line: { ...line, id, note: id ? undefined : "This product has options: open the page and pick them." } };
  }
  if (platform === "bigcommerce") {
    const id = bigcommerceProductId(page.body);
    return { origin, platform, line: { ...line, id, note: id ? undefined : "Open the page to add it." } };
  }
  return { origin, platform, line: { ...line, note: platform === "other" ? "This store has no cart link: add it on its page." : undefined } };
}

/** Builds one cart per store from product pages. */
export async function buildStoreCarts(items: Array<{ url: string; quantity?: number; option?: string }>): Promise<{ carts: StoreCart[]; failed: Array<{ url: string; reason: string }> }> {
  const byOrigin = new Map<string, { platform: Platform; lines: StoreLine[] }>();
  const failed: Array<{ url: string; reason: string }> = [];
  const resolved = await Promise.all(
    items.slice(0, 40).map((it) =>
      resolveProduct(String(it.url), it.quantity ?? 1, it.option).catch((e: unknown) => {
        failed.push({ url: String(it.url), reason: e instanceof Error ? e.message : "Couldn't read the page." });
        return null;
      }),
    ),
  );
  for (const r of resolved) {
    if (!r) continue;
    const s = byOrigin.get(r.origin) ?? { platform: r.platform, lines: [] };
    if (s.platform === "other" && r.platform !== "other") s.platform = r.platform;
    s.lines.push(r.line);
    byOrigin.set(r.origin, s);
  }
  const carts = [...byOrigin].map(([origin, s]) => {
    const total = subtotal(s.lines);
    return { store: new URL(origin).hostname.replace(/^www\./, ""), platform: s.platform, lines: s.lines, links: cartLinks(origin, s.platform, s.lines), subtotalCents: total.cents, currency: total.currency };
  });
  return { carts, failed };
}

/* ---------- The connector ---------- */

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "store_cart",
    description:
      "Builds a cart on other online stores (not Amazon, not this catalog) from product pages on the store's own site. Reads each page, picks the option, gets the live price, and returns each store's own add-to-cart link that the shopper opens to get the items in their own cart there. Group everything for the trip or project in one call.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          maxItems: 40,
          items: {
            type: "object",
            properties: {
              url: { type: "string", description: "The product page on the store's own site (https), from your web_search or web_fetch results" },
              quantity: { type: "integer", minimum: 1, maximum: 999 },
              option: { type: "string", description: "The option to pick when the product has several (size, voltage, colour), in the store's words" },
            },
            required: ["url"],
          },
        },
      },
      required: ["items"],
    },
  },
];

export function storeCartCard(c: StoreCart): StoreCartCard {
  return {
    kind: "store-cart",
    id: `sc_${c.store}`,
    store: c.store,
    platform: c.platform,
    links: c.links,
    subtotal: c.subtotalCents == null ? null : money(c.subtotalCents, c.currency),
    lines: c.lines.map((l) => ({ title: l.title, option: l.option, quantity: l.quantity, price: l.priceCents == null ? null : money(l.priceCents * l.quantity, l.currency), url: l.url, needsHand: !l.id })),
    group: "Store carts",
  };
}

/** What the model reads back about the carts. */
export function cartSummary(r: { carts: StoreCart[]; failed: Array<{ url: string; reason: string }> }) {
  return {
    carts: r.carts.map((c) => ({
      store: c.store,
      platform: c.platform,
      subtotal: money(c.subtotalCents, c.currency),
      cart_links: c.links,
      lines: c.lines.map((l) => ({
        title: l.title,
        option: l.option ?? null,
        quantity: l.quantity,
        unit_price: money(l.priceCents, l.currency),
        in_stock: l.available,
        in_link: !!l.id,
        ...(l.options ? { options: l.options.slice(0, 30) } : {}),
        ...(l.note ? { note: l.note } : {}),
        page: l.url,
      })),
    })),
    failed: r.failed,
    next:
      "Show the shopper each store's subtotal and its cart link. Shopify stores fill the whole cart from one link; WooCommerce and BigCommerce stores take one link per product, opened in turn in the same browser. Lines not in a link are added by hand on their page. Shipping and taxes are added at each store's checkout.",
  };
}

async function run(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult> {
  if (tool !== "store_cart") return { content: `Unknown tool ${tool}`, isError: true };
  const items = (Array.isArray(input.items) ? input.items : []) as Array<{ url: string; quantity?: number; option?: string }>;
  if (!items.length) return { content: "Give at least one product page URL.", isError: true };
  ctx.progress(`Building carts on ${new Set(items.map((i) => { try { return new URL(i.url).hostname; } catch { return i.url; } })).size} store(s)…`);
  const r = await buildStoreCarts(items);
  if (r.carts.length) ctx.show("Store carts", r.carts.map(storeCartCard));
  return { content: JSON.stringify(cartSummary(r)), isError: !r.carts.length };
}

export const storesConnector: Connector = {
  id: "stores",
  label: "Other stores (cart links)",
  enabled: () => true,
  prompt: () => `
Other online stores:
- When the shopper wants things this catalog and Amazon don't carry well (specialist parts, a brand's own store), find the product on the seller's own site with web_search and web_fetch, then call store_cart with the product page URLs and quantities, all in one call. It reads each page, picks the option you name, gets the live price and returns each store's own cart link; the shopper opens it and the items land in their own cart there, where they check out.
- Pass the option in the store's words when a product has several (voltage, size). If a line comes back with options, pick the one that matches what the shopper needs and call store_cart again for it.
- Quote only the prices store_cart returns, in that store's currency, and say shipping and taxes are added at each store's checkout. Never buy, sign in or type payment details anywhere.`,
  tools: TOOLS,
  run,
};
