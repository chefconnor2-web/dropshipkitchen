// Open sourcing: when CJ doesn't carry something (industrial machinery, custom tooling, raw materials in bulk,
// anything a dropshipping catalog won't have), Neon searches the web for real suppliers and shows them as
// cards. The shopper contacts those suppliers themselves; nothing from outside goes in our cart.
//
// Web search runs on Anthropic's servers ($10 per 1,000 searches, plus the tokens the results add), so each
// request is capped, and supplier cards may only link to pages the searches actually returned.

import type Anthropic from "@anthropic-ai/sdk";
import type { SupplierCard } from "@/lib/flights-shared";

/** Off with SOURCING_WEB=off (for instance if web search isn't enabled for the API key's organization). */
export function webSourcingEnabled(): boolean {
  return (process.env.SOURCING_WEB?.trim().toLowerCase() || "on") !== "off";
}

// Per API request. A big brief takes one or two requests, so a turn stays around a dozen searches.
const MAX_SEARCHES = 6;
const MAX_FETCHES = 4;
const MAX_SUPPLIERS = 12;

/** Anthropic's web tools, for planner models that support dynamic filtering (Sonnet/Opus 4.6 and later). */
export function webTools(): Anthropic.Beta.BetaToolUnion[] {
  return [
    { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: MAX_FETCHES, max_content_tokens: 8000 },
  ];
}

export const SUPPLIER_TOOL: Anthropic.Beta.BetaTool = {
  name: "show_suppliers",
  description:
    "Show outside suppliers you found with web_search as cards (name, link, what they offer, where, listed price, MOQ). Only for things our catalog doesn't carry. Every url must be a page your searches returned. The shopper contacts them for a quote; they can't be added to the cart.",
  input_schema: {
    type: "object",
    properties: {
      group: { type: "string", description: 'What these suppliers are for, e.g. "Extrusion press".' },
      suppliers: {
        type: "array",
        maxItems: MAX_SUPPLIERS,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Company or store name as the page shows it." },
            url: { type: "string", description: "The supplier's page from your search results." },
            offer: { type: "string", description: "What they sell that matches, with the key specs the page states." },
            location: { type: "string", description: 'Where they are, if the page says ("Tengzhou, Shandong").' },
            price: { type: "string", description: "Price exactly as listed, with unit. Leave out if not listed." },
            moq: { type: "string", description: "Minimum order, if listed." },
            note: { type: "string", description: "One short caveat or what to confirm with them." },
          },
          required: ["name", "url", "offer"],
        },
      },
    },
    required: ["group", "suppliers"],
  },
};

export function sourcingPrompt(): string {
  return `
Sourcing outside the catalog:
- Always search this catalog first with find_products. If it has nothing that fits, or the request is something a dropshipping catalog won't carry (industrial machinery, custom tooling or dies, raw materials by the tonne, made-to-order parts), find real suppliers on the web with web_search, then call show_suppliers with the best ones. Prefer manufacturers and factories (company sites, Alibaba, Made-in-China, Global Sources, 1688) over resellers, and look for 2-3 per item.
- Use web_fetch only to read a promising supplier or spec page from your results. Keep searches focused: one or two per item, in English, adding the Chinese keyword the shopper gives when it helps.
- Only show suppliers and facts the pages actually state: name, what they make, specs, location, price and MOQ as listed. Never invent prices, stock, specs, lead times or contact details. If a spec the shopper needs (tonnage, stroke, daylight, voltage) isn't on the page, say it has to be confirmed with the supplier.
- Make clear these are outside suppliers we haven't vetted: the shopper contacts them for a quote and buys from them directly; they can't go in this cart. For large purchases, suggest a sample or video call, third-party inspection before shipping, a trade-assurance or escrow payment and clear Incoterms (FOB or CIF).
- For a full brief (a production line, a bill of materials), answer item by item: suppliers per item, then a short request-for-quote message the shopper can send (the exact specs to ask for), then anything else they asked for. When you estimate weight, volume (CBM) or which container fits, show your assumptions and call it an estimate; say heavy presses usually ship on a flat rack or open top and that the supplier quotes the packed size.
- Flag safety and compliance where it matters (press guarding and CE marking, local electrical code for 380V gear, handling hazardous chemicals).`;
}

/** Every page the web tools returned in this conversation, so supplier cards can only link to real results. */
export function seenPages(content: ReadonlyArray<Anthropic.Beta.BetaContentBlock | Anthropic.Beta.BetaContentBlockParam>, into: Set<string>): Set<string> {
  for (const b of content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.url) into.add(normalize(r.url));
    if (b.type === "web_fetch_tool_result" && b.content.type === "web_fetch_result" && b.content.url) into.add(normalize(b.content.url));
  }
  return into;
}

function normalize(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Short stable id for a link (cards are keyed by it). */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * The supplier cards to show. A card's link must be a page the searches returned, or at least on a site they
 * returned; anything else is dropped, so a made-up link never reaches the shopper.
 */
export function parseSuppliers(input: Record<string, unknown>, seen: Set<string>): { group: string; cards: SupplierCard[]; dropped: string[] } {
  const group = text(input.group, 60) || "Suppliers";
  const hosts = new Set([...seen].map((p) => p.split("/")[0]));
  const cards: SupplierCard[] = [];
  const dropped: string[] = [];
  for (const raw of (Array.isArray(input.suppliers) ? input.suppliers : []).slice(0, MAX_SUPPLIERS)) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = text(o.name, 80);
    const url = text(o.url, 600);
    const offer = text(o.offer, 240);
    if (!name || !offer) continue;
    if (!/^https?:\/\//i.test(url) || !(seen.has(normalize(url)) || hosts.has(hostOf(url)))) {
      dropped.push(name);
      continue;
    }
    const card: SupplierCard = { kind: "supplier", id: `sp_${hash(url)}`, name, url, offer, group };
    const location = text(o.location, 80);
    const price = text(o.price, 80);
    const moq = text(o.moq, 60);
    const note = text(o.note, 160);
    if (location) card.location = location;
    if (price) card.price = price;
    if (moq) card.moq = moq;
    if (note) card.note = note;
    cards.push(card);
  }
  return { group, cards, dropped };
}
