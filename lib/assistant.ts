// Sourcing assistant. A shopper describes a project ("battery setup for a custom e-bike"); a planner model
// (Claude Sonnet 5.5) breaks it into parts and sends cheap scout agents (Claude Haiku 4.5), one per part and
// in parallel, to search CJ's live catalog and shortlist the best matches. The planner checks compatibility
// and adds what the shopper approves to their cart. Everything runs server-side; finds stream to the shopper
// as they arrive.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { searchCatalog, type CatalogHit } from "@/lib/catalog-search";
import { openCjProduct, prewarmProducts } from "@/lib/open-product";
import { addVariantToCart } from "@/lib/cart-add";
import { cartBoxPicks, cartShipItems, getShipTo, loadCart } from "@/lib/cart";
import { blockedMessage, countryLabel, quoteCart } from "@/lib/shipping";
import { stockLabel, stockStatus } from "@/lib/inventory";
import { addKitToCart, type Kit, type KitItem } from "@/lib/kit";
import { bulkPricingLabel, priceOrder } from "@/lib/volume";
import { parsePersonalizeConfig } from "@/lib/personalize-shared";
import { costMicros } from "@/lib/ai-cost";
import { warehouseLabel, warehousesFrom } from "@/lib/warehouses";

// Planner: Claude Sonnet 5.5 ($2 / $10 per MTok) at medium effort. Scouts: Claude Haiku 4.5 ($1 / $5).
export const MODEL = process.env.ASSISTANT_MODEL?.trim() || "claude-sonnet-5-5";
const SCOUT_MODEL = process.env.ASSISTANT_SCOUT_MODEL?.trim() || "claude-haiku-4-5";
export const EFFORT = (process.env.ASSISTANT_EFFORT?.trim() || "medium") as "low" | "medium" | "high";
const MAX_TOOL_ROUNDS = 8;
const MAX_SCOUT_ROUNDS = 3;
// CJ answers one search at a time (~1 req/s), so every extra search is felt by the shopper.
const MAX_SCOUT_SEARCHES = 2;
const MAX_PARTS = 8;
const SCOUT_CONCURRENCY = 5;
const MAX_USER_TURNS = 40;
const MAX_MESSAGE_CHARS = 1000;

export function assistantConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

export interface ProductCard {
  pid: string;
  title: string;
  fromCents: number;
  group?: string;
}
export type UiEntry =
  /** reaction: the assistant's emoji tapback on this message; at: when it was sent (ISO). */
  | { role: "user"; text: string; images?: string[]; reaction?: string; at?: string }
  | { role: "assistant"; text: string; cards: ProductCard[]; added: string[]; kit?: Kit; at?: string };

/** Live events for the chat panel while a turn runs. */
export type AssistantEvent =
  | { type: "progress"; note: string }
  | { type: "found"; group: string; cards: ProductCard[]; done: boolean }
  /** Streamed words of the answer as the model writes them. */
  | { type: "text"; delta: string }
  /** The model finished a burst of text and is about to use tools. */
  | { type: "break" }
  /** The assistant's emoji tapback on the shopper's message (arrives before the answer, like a friend reacting). */
  | { type: "react"; emoji: string };

function systemPrompt(): string {
  return `You are the sourcing assistant for ${config.storeName}, a Canadian B2B store where businesses and makers order almost anything from Chinese factories. Shoppers describe what they're building or need; you turn that into a concrete parts list, find real products, and add the ones they approve to their cart.

How to work:
- Think through everything the project needs: the main components, the parts that connect them (wiring, connectors, mounts, fuses), and the tools to do it yourself.
- Find parts with find_products, all of them in one call: it sends a scout to search the live catalog for each part in parallel and returns a shortlist per part. Give each part a clear need (specs that matter, like voltage, size, connector type) and 1-3 short keyword queries (1-3 plain words each, e.g. "48v battery", "xt90 connector"). If a part comes back empty, try once more with different keywords before giving up.
- Only recommend products that find_products returned, at the price it returned. Never invent products, prices, specs or delivery times. If something isn't available, say so and suggest an alternative from this catalog. Never send shoppers to other stores or websites.
- Don't open products while planning. Call get_product only for items you're about to add, or to check a spec you need.
- When the shopper says to add something, add it in the same turn: get_product, then add_to_cart with the exact variant_id. Don't ask for confirmation again. If they asked you to build the whole cart, add your clear picks and list what you added. Otherwise add only what they asked for or agreed to.
- Match parts to each other: voltage, connectors, sizes and wattage must be compatible. Point out anything the shopper must confirm.
- Batteries and chargers must match exactly in chemistry and charge voltage. A "48V" Li-ion (NMC, 13S) pack charges at 54.6V; a "48V" LiFePO4 (16S) pack charges at 58.4V. Never pair a LiFePO4 charger with a Li-ion pack or the reverse: it can overcharge and start a fire. Confirm both from get_product's description; if you can't, say so and don't add the charger.
- Before adding an accessory, check the main product's description for what's included (charger, BMS, connectors, mounts) and don't add duplicates; tell the shopper what's already in the box.
- For lithium batteries, high voltage or mains wiring, add one short safety note. Don't help with anything illegal or dangerous.
- Prices are USD per unit and already include our margin. ${bulkPricingLabel()}; the cart applies it to the whole order. Prices you quote are list prices, so say the cart total will be lower for bulk orders, and use view_cart for the real total. Shipping is quoted for the shopper's postal code in the cart; orders too heavy for one parcel are split into several parcels automatically, so large quantities are fine. For bulk quantities, add the quantity they need; stock is re-checked live.
- After you present picks for a project, call propose_kit once with your recommended pick for each part you found (sensible quantities; an option in words when it matters, e.g. "20Ah"). The shopper sees it as a kit card with an "Add entire kit" button.
- When the shopper asks to add the whole kit, everything, or all of it, call add_kit in the same turn with the kit's items (adjusted for anything they changed). Don't ask again; afterwards, list what was added and anything that failed.
- Shoppers can send photos: a broken or worn part, a product they want more of, a label, spec plate or packaging, a sketch, or a space to fit out. Say briefly what you see and read any model numbers, voltages, sizes or connectors in it, then search for that exact item or compatible parts. If a key spec isn't visible, ask for it or for another photo.
- Warehouses: products in CJ's US warehouse ship to US addresses only; products in the China warehouse ship to the US and Canada; products in CJ's Canadian warehouse ship within Canada in 3-7 days (vs 1-3 weeks from China). For a Canadian shopper in a hurry, search with from_canada: true first, and fall back to the full catalog if it comes up short. get_product's ships_from says which applies; mention it when it matters (a US-warehouse-only item for a Canadian shopper can't be sent to them).
- Sea shipping: if ships_to_shopper is NO for a shopper in Canada and the product isn't US-warehouse-only (usually a big lithium battery, which can't fly), it can still go to Canada by boat from China, about 4–7 weeks, priced per order. Tell them they can add it and tap "Get a sea-shipping price" in the cart; don't put it in a kit with fast-shipping items without saying so.
- get_product says whether the product can ship to the shopper's country (ships_to_shopper). If it says NO, don't add it or put it in a kit: tell the shopper it can't ship to them and find an alternative that does (for a large lithium battery, try other packs; some ship from other warehouses). If a cart can't ship, view_cart and the cart page name the item that blocks it.
- Some products are made with the shopper's own photo or text (print on demand). When they want something custom, personalized, printed with a photo, logo or name, or a personal gift, call show_personalized_products and point them to those cards. You can't add these to the cart yourself: tell them to tap Add on the card, which opens a designer where they upload a photo (any they already sent you is one tap away) or type text, see a preview, and add it. Personalized items can't be returned, so mention that they should check the preview.
- Be concise: a short intro, then the picks per part as a bullet list with name and price, then any questions. The shopper sees photo cards for every shortlisted product, so don't paste links.`;
}

const VOICE_NOTE = `\n\nThe shopper is talking to you by voice and your reply is read aloud. Answer in two to four short spoken sentences with no lists, headings, markdown or prices with cents. Still use the tools as usual; the product and kit cards show the details on screen.`;

/** Image blocks are stored as "img:<id>" placeholders and filled in from the database before each API call. */
const IMG_PREFIX = "img:";

async function hydrateImages(messages: Anthropic.Beta.BetaMessageParam[]): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const ids = new Set<string>();
  for (const m of messages)
    if (m.role === "user" && Array.isArray(m.content))
      for (const b of m.content) if (b.type === "image" && b.source.type === "base64" && b.source.data.startsWith(IMG_PREFIX)) ids.add(b.source.data.slice(IMG_PREFIX.length));
  if (!ids.size) return messages;
  const rows = await prisma.assistantImage.findMany({ where: { id: { in: [...ids] } } });
  const data = new Map(rows.map((r) => [r.id, { mime: r.mime, b64: Buffer.from(r.data).toString("base64") }]));
  return messages.map((m) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((b): Anthropic.Beta.BetaContentBlockParam => {
        if (b.type !== "image" || b.source.type !== "base64" || !b.source.data.startsWith(IMG_PREFIX)) return b;
        const img = data.get(b.source.data.slice(IMG_PREFIX.length));
        return img ? { type: "image", source: { type: "base64", media_type: img.mime as "image/jpeg", data: img.b64 } } : { type: "text", text: "[A photo that is no longer available.]" };
      }),
    };
  });
}

/** Index in the API history where the shopper's n-th message starts (tool results don't count as messages). */
function userMessageStart(messages: Anthropic.Beta.BetaMessageParam[], n: number): number {
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const real = m.role === "user" && (typeof m.content === "string" || m.content.some((b) => b.type !== "tool_result"));
    if (real && seen++ === n) return i;
  }
  return messages.length;
}

/** A short title for the chat sidebar, from the shopper's first message. */
export async function generateTitle(text: string, hasImage: boolean): Promise<string> {
  const fallback = text.trim().replace(/\s+/g, " ").slice(0, 48) || "Photo search";
  try {
    const r = await new Anthropic().messages.create({
      model: SCOUT_MODEL,
      max_tokens: 24,
      messages: [{ role: "user", content: `Write a 2-5 word title for a shopping chat that starts with this request${hasImage ? " (with a photo)" : ""}. Reply with the title only, no quotes or punctuation at the end.\n\n${text.slice(0, 500) || "(only a photo)"}` }],
    });
    const t = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim().replace(/^["'“]|["'”.]$/g, "");
    return t && t.length <= 60 ? t : fallback;
  } catch {
    return fallback;
  }
}

/** Tapbacks the assistant may use: warm, never mocking (no 😂 or 👎 on a customer's request). */
export const REACTIONS = ["❤️", "👍", "‼️", "🔥", "👀", "🙌", "💯", "🤝", "😮", "🙏", "🎉", "⚡", "📦", "🛠️", "😍", "🫡"] as const;
const REACTION_SET = new Set<string>(REACTIONS);

/** Normalizes a model's reply to one allowed emoji ("❤" and "❤️" are the same tapback), or null for none. */
export function parseReaction(raw: string): string | null {
  const t = raw.trim().split(/\s+/)[0] ?? "";
  if (REACTION_SET.has(t)) return t;
  const withVs = t.replace(/\uFE0F/g, "") + "\uFE0F";
  if (REACTION_SET.has(withVs)) return withVs;
  return REACTIONS.find((r) => r.replace(/\uFE0F/g, "") === t.replace(/\uFE0F/g, "")) ?? null;
}

/**
 * Picks the emoji tapback the assistant leaves on a shopper's message, the way a friend reacts in iMessage.
 * A tiny, fast call (a fraction of a cent) that runs alongside the answer; its cost counts toward the plan budget.
 */
export async function pickReaction(text: string, hasImage: boolean): Promise<{ emoji: string | null; micros: number }> {
  if (!text.trim() && !hasImage) return { emoji: null, micros: 0 };
  try {
    const r = await new Anthropic().messages.create({
      model: SCOUT_MODEL,
      max_tokens: 8,
      system: `You are a friendly shopping assistant texting with a customer in iMessage. React to their latest message with ONE tapback emoji, the way a warm, upbeat person would. Pick from: ${REACTIONS.join(" ")}. Excited project or big order: 🔥 🙌 ⚡. Thanks or kind words: ❤️ 🙏. A clear request: 👍 🫡 🛠️ 📦. A photo: 👀 😍. Reply with the emoji only. Reply "none" if a reaction would feel wrong (a complaint, a problem with an order, or anything sad or sensitive).`,
      messages: [{ role: "user", content: `${hasImage ? "[sent a photo] " : ""}${text.slice(0, 600)}` }],
    });
    const out = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { emoji: parseReaction(out), micros: costMicros(r.model, r.usage) };
  } catch {
    return { emoji: null, micros: 0 };
  }
}

const PLANNER_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "find_products",
    description:
      "Send scouts to search the live catalog (millions of products shipped from China) for several parts at once, in parallel. Returns up to 3 shortlisted products per part, each with pid, title, starting price in USD and a note on fit.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        parts: {
          type: "array",
          description: `The parts to find, up to ${MAX_PARTS}. Group small consumables (heat shrink, cable ties) into one part.`,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short label shown to the shopper, e.g. 'Battery'" },
              need: { type: "string", description: "What a good match must have, e.g. '48V Li-ion, 20Ah, for e-bike, XT90 output'" },
              queries: { type: "array", items: { type: "string" }, description: "1-3 short keyword queries" },
            },
            required: ["name", "need", "queries"],
            additionalProperties: false,
          },
        },
        from_canada: {
          type: "boolean",
          description: "true to search only CJ's Canadian warehouse (delivered in Canada in 3-7 days; a much smaller range). Use when a shopper in Canada needs it fast or asks for local stock.",
        },
      },
      required: ["parts", "from_canada"],
      additionalProperties: false,
    },
  },
  {
    name: "get_product",
    description: "Load one product's purchasable options (variants) with each option's variant_id, price, stock and the description. Call before add_to_cart.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { pid: { type: "string", description: "The pid from find_products" } },
      required: ["pid"],
      additionalProperties: false,
    },
  },
  {
    name: "add_to_cart",
    description: "Add a product option to the shopper's cart. Stock is re-checked live; the result says whether it worked.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        variant_id: { type: "string", description: "variant_id from get_product" },
        quantity: { type: "integer", description: "Units to add, 1-999" },
      },
      required: ["variant_id", "quantity"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_kit",
    description: "Show the shopper a kit card: one recommended product per part, with quantities and an 'Add entire kit' button. Use pids from find_products only.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short kit name, e.g. '48V e-bike battery kit'" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              part: { type: "string", description: "Part label, e.g. 'Battery'" },
              pid: { type: "string", description: "pid from find_products" },
              quantity: { type: "integer", description: "Units, 1-999" },
              option: { type: "string", description: "Preferred option in words, or empty" },
            },
            required: ["part", "pid", "quantity", "option"],
            additionalProperties: false,
          },
        },
      },
      required: ["name", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "add_kit",
    description: "Add several products to the cart in one go (the whole kit). Each item's best-matching option is picked from its option hint; stock is checked live. Returns what was added and what failed.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              part: { type: "string", description: "Part label, e.g. 'Battery'" },
              pid: { type: "string", description: "pid from find_products" },
              quantity: { type: "integer", description: "Units, 1-999" },
              option: { type: "string", description: "Preferred option in words, or empty" },
            },
            required: ["part", "pid", "quantity", "option"],
            additionalProperties: false,
          },
        } },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "show_personalized_products",
    description:
      "List the products this store prints with the shopper's own photo or text, and show them as cards the shopper taps to design. Returns each product's pid, title, starting price and whether it takes a photo, text or both.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "view_cart",
    description: "Show what is in the shopper's cart now, with quantities and the subtotal.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

/** view_cart's shipping line: the cheapest price to the shopper, or what blocks the cart. */
async function cartShipping(cart: Awaited<ReturnType<typeof loadCart>>): Promise<string> {
  try {
    const shipTo = await getShipTo();
    const q = await quoteCart(cartShipItems(cart, await cartBoxPicks(cart)), shipTo.country, shipTo.zip);
    if (q.tiers.length) return `${countryLabel(shipTo.country)}: from ${formatMoney(q.tiers[0].cents)}`;
    const nameOf = (vid: string) => cart?.items.find((i) => i.variant.offer?.cjSupplierVariant.cjVariantId === vid)?.variant.product.title;
    return blockedMessage(q.blocked, nameOf, shipTo.country) ?? `This cart can't ship to ${countryLabel(shipTo.country)} as it is.`;
  } catch {
    return "Couldn't check shipping right now.";
  }
}

// ---------- scouts ----------

const SCOUT_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_catalog",
    description: "Keyword search over the live catalog. Returns up to 15 products with pid, title and starting price in USD. Use 1-3 word queries.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Short keyword query" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_picks",
    description: "Report your shortlist and finish. Call exactly once, after searching.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        picks: {
          type: "array",
          description: "Best 1-3 matches, best first. Empty if nothing fits.",
          items: {
            type: "object",
            properties: { pid: { type: "string" }, note: { type: "string", description: "One short line on why it fits or what to check" } },
            required: ["pid", "note"],
            additionalProperties: false,
          },
        },
      },
      required: ["picks"],
      additionalProperties: false,
    },
  },
];

export interface Part {
  name: string;
  need: string;
  queries: string[];
  /** Search only this warehouse country ("CA": CJ's Canadian warehouse). */
  from?: string;
}
export interface ScoutResult {
  part: string;
  picks: Array<{ pid: string; title: string; from_price_usd: string; note: string }>;
}

async function scout(client: Anthropic, part: Part, emit: (e: AssistantEvent) => void, usage: { in: number; out: number; micros: number }): Promise<ScoutResult> {
  const seen = new Map<string, CatalogHit>();
  const search = async (q: string) => {
    const query = q.trim().slice(0, 80);
    if (!query) return [];
    emit({ type: "progress", note: `${part.name}: searching “${query}”…` });
    const { hits } = await searchCatalog(query, 1, part.from);
    const top = hits.slice(0, 15);
    for (const h of top) seen.set(h.pid, h);
    emit({ type: "found", group: part.name, cards: top.slice(0, 6).map((h) => ({ ...h, group: part.name })), done: false });
    return top;
  };

  // Run the planner's first query straight away, so the scout starts with results in hand.
  let searches = 1;
  const first = await search(part.queries[0] ?? part.name).catch(() => []);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Find the best products for this part.\nPart: ${part.name}\nMust have: ${part.need}\nOther queries you can try: ${part.queries.slice(1).join(", ") || "(your own)"}\n\nResults for "${part.queries[0] ?? part.name}":\n${JSON.stringify(first.map((h) => ({ pid: h.pid, title: h.title, price: (h.fromCents / 100).toFixed(2) })))}\n\nIf at least one result fits, call submit_picks now. Only if none fit, search once more with different short keywords, then call submit_picks with the best 1-3 that genuinely fit the need. Skip accessories, parts or mismatched specs.`,
    },
  ];

  let picks: Array<{ pid: string; note: string }> | null = null;
  for (let round = 0; round < MAX_SCOUT_ROUNDS && !picks; round++) {
    const r = await client.messages.create({
      model: SCOUT_MODEL,
      max_tokens: 1024,
      system: "You are a fast, careful product scout for a sourcing store. You only pick products from search results you were given, judged against the stated need.",
      tools: SCOUT_TOOLS,
      messages,
    });
    usage.in += r.usage.input_tokens;
    usage.out += r.usage.output_tokens;
    usage.micros += costMicros(r.model, r.usage);
    messages.push({ role: "assistant", content: r.content });
    const calls = r.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!calls.length) break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const c of calls) {
      const input = c.input as Record<string, unknown>;
      if (c.name === "submit_picks") {
        picks = (Array.isArray(input.picks) ? input.picks : []) as Array<{ pid: string; note: string }>;
        results.push({ type: "tool_result", tool_use_id: c.id, content: "Received." });
      } else if (searches >= MAX_SCOUT_SEARCHES) {
        results.push({ type: "tool_result", tool_use_id: c.id, content: "Search limit reached. Call submit_picks with the best of what you have.", is_error: true });
      } else {
        searches++;
        const hits = await search(String(input.query ?? "")).catch(() => []);
        results.push({
          type: "tool_result",
          tool_use_id: c.id,
          content: hits.length ? JSON.stringify(hits.map((h) => ({ pid: h.pid, title: h.title, price: (h.fromCents / 100).toFixed(2) }))) : "No results.",
        });
      }
    }
    if (!picks) messages.push({ role: "user", content: results });
  }

  // Fall back to the top results if the scout didn't submit; never return a pid it wasn't shown.
  const chosen = (picks ?? [...seen.keys()].slice(0, 3).map((pid) => ({ pid, note: "Top search result" })))
    .filter((p) => seen.has(p.pid))
    .slice(0, 3);
  const out = chosen.map((p) => {
    const h = seen.get(p.pid)!;
    return { pid: h.pid, title: h.title, from_price_usd: (h.fromCents / 100).toFixed(2), note: String(p.note ?? "").slice(0, 200) };
  });
  emit({ type: "found", group: part.name, cards: chosen.map((p) => ({ ...seen.get(p.pid)!, group: part.name })), done: true });
  return { part: part.name, picks: out };
}

/** Run up to SCOUT_CONCURRENCY scouts at a time. */
export async function runScouts(client: Anthropic, parts: Part[], emit: (e: AssistantEvent) => void, usage: { in: number; out: number; micros: number }) {
  const results: ScoutResult[] = new Array(parts.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCOUT_CONCURRENCY, parts.length) }, async () => {
      while (next < parts.length) {
        const i = next++;
        try {
          results[i] = await scout(client, parts[i], emit, usage);
        } catch {
          results[i] = { part: parts[i].name, picks: [] };
          emit({ type: "found", group: parts[i].name, cards: [], done: true });
        }
      }
    }),
  );
  return results;
}

// ---------- planner tools ----------

interface Ctx {
  cartId: string;
  cards: ProductCard[];
  /** Every product this chat has shown, so kits can only contain real search results. */
  known: Map<string, ProductCard>;
  kit?: Kit;
  added: string[];
  emit: (e: AssistantEvent) => void;
  client: Anthropic;
  usage: { in: number; out: number; micros: number };
}

async function runTool(name: string, input: Record<string, unknown>, ctx: Ctx): Promise<{ content: string; isError?: boolean }> {
  if (name === "find_products") {
    const parts = (Array.isArray(input.parts) ? input.parts : [])
      .slice(0, MAX_PARTS)
      .map((p) => {
        const o = p as Record<string, unknown>;
        const queries = (Array.isArray(o.queries) ? o.queries : []).map((q) => String(q)).filter(Boolean).slice(0, 3);
        return {
          name: String(o.name ?? "Item").slice(0, 40),
          need: String(o.need ?? "").slice(0, 300),
          queries: queries.length ? queries : [String(o.name ?? "")],
          ...(input.from_canada === true ? { from: "CA" } : {}),
        };
      });
    if (!parts.length) return { content: "No parts given.", isError: true };
    ctx.emit({ type: "progress", note: `Sending ${parts.length} scout${parts.length === 1 ? "" : "s"} to search…` });
    const results = await runScouts(ctx.client, parts, ctx.emit, ctx.usage);
    for (const r of results)
      for (const p of r.picks)
        if (!ctx.cards.some((c) => c.pid === p.pid))
          ctx.cards.push({ pid: p.pid, title: p.title, fromCents: Math.round(Number(p.from_price_usd) * 100), group: r.part });
    for (const c of ctx.cards) ctx.known.set(c.pid, c);
    return { content: JSON.stringify(results) };
  }
  if (name === "get_product") {
    ctx.emit({ type: "progress", note: "Checking options and stock…" });
    const product = await openCjProduct(String(input.pid ?? ""));
    if (!product) return { content: "That product isn't available. Pick another one.", isError: true };
    const variants = await prisma.productVariant.findMany({
      where: { productId: product.id, enabled: true },
      orderBy: { position: "asc" },
      take: 40,
      include: { offer: { include: { cjSupplierVariant: { select: { inventoryTotal: true, cjVariantId: true, inventoryJson: true, weightGrams: true } } } } },
    });
    // Can this product reach the shopper at all? (CJ has no route for some items, e.g. large lithium
    // batteries to some countries.) One unit of the first in-stock option, from any warehouse that stocks it.
    const shipTo = await getShipTo().catch(() => ({ country: "CA", zip: "" }));
    const warehouse = warehouseLabel(warehousesFrom(variants.map((v) => v.offer?.cjSupplierVariant.inventoryJson)));
    const probe = variants.find((v) => v.offer && stockStatus(v.offer.cjSupplierVariant.inventoryTotal) !== "UNAVAILABLE") ?? variants.find((v) => v.offer);
    let ships: string | undefined;
    if (probe?.offer) {
      const sv = probe.offer.cjSupplierVariant;
      const q = await quoteCart([{ vid: sv.cjVariantId, quantity: 1, inventoryJson: sv.inventoryJson, weightGrams: sv.weightGrams }], shipTo.country, shipTo.zip).catch(() => null);
      ships = !q ? "unknown (couldn't check shipping right now)" : q.tiers.length ? `yes, about ${formatMoney(q.tiers[0].cents)} for one unit` : "NO";
    }
    return {
      content: JSON.stringify({
        title: product.title,
        ...(ships ? { ships_to_shopper: `${countryLabel(shipTo.country)}: ${ships}` } : {}),
        ...(warehouse ? { ships_from: warehouse } : {}),
        options: variants
          .filter((v) => v.offer)
          .map((v) => ({
            variant_id: v.id,
            option: v.name,
            price_usd: (v.priceCents / 100).toFixed(2),
            stock: stockLabel(stockStatus(v.offer?.cjSupplierVariant.inventoryTotal)),
          })),
        description: product.description.slice(0, 1500),
        ...(product.personalizeJson
          ? { personalized: "Made with the shopper's own photo or text. You can't add it: tell them to tap Add on its card to open the designer." }
          : {}),
      }),
    };
  }
  if (name === "add_to_cart") {
    ctx.emit({ type: "progress", note: "Adding to your cart…" });
    const quantity = Math.max(1, Math.min(999, Number(input.quantity) || 1));
    const r = await addVariantToCart(ctx.cartId, String(input.variant_id ?? ""), quantity);
    if (r.ok) ctx.added.push(r.message.replace(/^Added /, "").replace(/ to your cart\.$/, ""));
    return { content: r.message, isError: !r.ok };
  }
  if (name === "propose_kit" || name === "add_kit") {
    const items: KitItem[] = (Array.isArray(input.items) ? input.items : [])
      .slice(0, 20)
      .map((x) => x as Record<string, unknown>)
      .map((x): KitItem | null => {
        const card = ctx.known.get(String(x.pid ?? ""));
        return card
          ? { part: String(x.part ?? card.group ?? "Item").slice(0, 40), pid: card.pid, title: card.title, fromCents: card.fromCents, quantity: Math.max(1, Math.min(999, Number(x.quantity) || 1)), option: String(x.option ?? "").slice(0, 80) || undefined }
          : null;
      })
      .filter((x): x is KitItem => !!x);
    if (!items.length) return { content: "None of those pids came from find_products in this chat.", isError: true };
    if (name === "propose_kit") {
      ctx.kit = { id: `kit_${Date.now().toString(36)}`, name: String(input.name ?? "Your kit").slice(0, 60), items };
      const total = items.reduce((n, i) => n + i.fromCents * i.quantity, 0);
      return { content: `Kit card shown with ${items.length} items, from about ${formatMoney(total)} before options and shipping. The shopper can add it all with one tap, or ask you to.` };
    }
    ctx.emit({ type: "progress", note: `Adding ${items.length} items to your cart…` });
    const results = await addKitToCart(ctx.cartId, items, (done, total, r) =>
      ctx.emit({ type: "progress", note: `${r.ok ? "✓" : "✗"} ${r.part} (${done}/${total})` }),
    );
    for (const r of results) if (r.ok) ctx.added.push(`${r.message} · ${r.title}`);
    return { content: JSON.stringify(results) };
  }
  if (name === "show_personalized_products") {
    const products = await prisma.product.findMany({
      where: { status: "PUBLISHED", personalizeJson: { not: null }, supplierProduct: { isNot: null } },
      include: { supplierProduct: { select: { cjProductId: true } }, variants: { where: { enabled: true, offer: { isNot: null } }, select: { priceCents: true } } },
      take: 12,
    });
    const rows = products.flatMap((p) => {
      const cfg = parsePersonalizeConfig(p.personalizeJson);
      const from = Math.min(...p.variants.map((v) => v.priceCents));
      if (!cfg || !p.supplierProduct || !Number.isFinite(from)) return [];
      const card: ProductCard = { pid: p.supplierProduct.cjProductId, title: p.title, fromCents: from, group: "Personalize it" };
      if (!ctx.cards.some((c) => c.pid === card.pid)) ctx.cards.push(card);
      ctx.known.set(card.pid, card);
      return [{ pid: card.pid, title: p.title, from_price_usd: (from / 100).toFixed(2), takes: [cfg.allowPhoto && "photo", cfg.allowText && "text"].filter(Boolean).join(" or ") }];
    });
    if (!rows.length) return { content: "This store has no personalized products right now. Say so, and offer to find regular products instead." };
    return { content: JSON.stringify({ products: rows, note: "Shown as cards. The shopper taps Add on a card to design it; you can't add these yourself." }) };
  }
  if (name === "view_cart") {
    const cart = await loadCart(ctx.cartId);
    const items = cart?.items ?? [];
    if (!items.length) return { content: "The cart is empty." };
    const priced = priceOrder(items.map((i) => ({ listCents: i.variant.priceCents, costCents: i.variant.offer?.cjSupplierVariant.supplierPriceCents, quantity: i.quantity })));
    const unit = (i: (typeof items)[number]) => priced.unitCents[items.indexOf(i)];
    const subtotal = priced.totalCents;
    return {
      content: JSON.stringify({
        items: items.map((i) => ({ title: i.variant.product.title, option: i.variant.name, quantity: i.quantity, line_total_usd: ((unit(i) * i.quantity) / 100).toFixed(2) })),
        subtotal: formatMoney(subtotal),
        bulk_savings: priced.savingsCents ? formatMoney(priced.savingsCents) : null,
        shipping: await cartShipping(cart),
      }),
    };
  }
  return { content: `Unknown tool ${name}.`, isError: true };
}

export class AssistantLimitError extends Error {}

/** One shopper turn: runs the planner's tool loop to completion and returns what the chat panel should show. */
export interface TurnInput {
  text: string;
  /** AssistantImage ids, already checked to belong to this visitor. */
  images?: Array<{ id: string; mime: string }>;
  /** The shopper is in voice mode: answer briefly, for reading aloud. */
  voice?: boolean;
  /** Replace the conversation from this transcript entry (a user message) on: edit or regenerate. */
  editIndex?: number;
}

export async function chatTurn(
  chatId: string,
  cartId: string,
  input: TurnInput,
  emit: (e: AssistantEvent) => void = () => {},
): Promise<{ entry: UiEntry & { role: "assistant" }; costMicros: number; reaction: string | null }> {
  const text = input.text.trim().slice(0, MAX_MESSAGE_CHARS);
  const images = (input.images ?? []).slice(0, 4);
  const sentAt = new Date().toISOString();
  const chat = await prisma.assistantChat.findUniqueOrThrow({ where: { id: chatId } });

  // History is otherwise append-only: thinking and fallback blocks must go back to the API exactly as received.
  let messages = JSON.parse(chat.messagesJson) as Anthropic.Beta.BetaMessageParam[];
  let ui = JSON.parse(chat.uiJson) as UiEntry[];
  let turns = chat.userTurns;
  if (input.editIndex != null && input.editIndex >= 0 && input.editIndex < ui.length && ui[input.editIndex].role === "user") {
    const n = ui.slice(0, input.editIndex).filter((e) => e.role === "user").length;
    messages = messages.slice(0, userMessageStart(messages, n));
    ui = ui.slice(0, input.editIndex);
    turns = n;
  }
  if (turns >= MAX_USER_TURNS) throw new AssistantLimitError("This chat is full. Start a new one to keep going.");
  // The tapback lands while the answer is still being written.
  const reacting = pickReaction(text, images.length > 0).then((r) => {
    if (r.emoji) emit({ type: "react", emoji: r.emoji });
    return r;
  });
  messages.push({
    role: "user",
    content: images.length
      ? [
          ...images.map((im): Anthropic.Beta.BetaImageBlockParam => ({ type: "image", source: { type: "base64", media_type: im.mime as "image/jpeg", data: IMG_PREFIX + im.id } })),
          { type: "text", text: text || "Here's a photo. What is this, and can you find it or compatible parts?" },
        ]
      : text,
  });
  const client = new Anthropic();
  const usage = { in: 0, out: 0, micros: 0 };
  const known = new Map<string, ProductCard>();
  for (const e of ui) if (e.role === "assistant") for (const c of e.cards) known.set(c.pid, c);
  const ctx: Ctx = { cartId, cards: [], known, added: [], emit, client, usage };
  const haikuPlanner = MODEL.startsWith("claude-haiku");
  let reply = "";
  const texts: string[] = [];

  emit({ type: "progress", note: "Thinking…" });
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Stream so the shopper sees the answer being written; finalMessage() gives the complete turn.
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      system: systemPrompt() + (input.voice ? VOICE_NOTE : ""),
      tools: PLANNER_TOOLS,
      cache_control: { type: "ephemeral" },
      messages: await hydrateImages(messages),
      // Effort and refusal fallbacks are Sonnet/Opus features; Haiku rejects them.
      ...(haikuPlanner ? {} : { output_config: { effort: EFFORT }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    });
    stream.on("text", (delta) => emit({ type: "text", delta }));
    const response = await stream.finalMessage();
    usage.in += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    usage.out += response.usage.output_tokens;
    // Priced by the model that actually answered (a refusal fallback can switch it).
    usage.micros += costMicros(response.model, response.usage);
    messages.push({ role: "assistant", content: response.content });
    const roundText = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    // The saved reply is everything the shopper watched being written, across rounds.
    if (roundText) texts.push(roundText);
    reply = texts.join("\n\n");

    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason === "refusal") reply = "Sorry, I can't help with that one.";
      break;
    }
    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (roundText) emit({ type: "break" });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
      calls.map(async (c) => {
        try {
          const r = await runTool(c.name, c.input as Record<string, unknown>, ctx);
          return { type: "tool_result" as const, tool_use_id: c.id, content: r.content, ...(r.isError ? { is_error: true } : {}) };
        } catch (e) {
          return { type: "tool_result" as const, tool_use_id: c.id, content: `Tool failed: ${e instanceof Error ? e.message : e}`, is_error: true };
        }
      }),
    );
    // All results for one assistant turn go back in a single user message.
    messages.push({ role: "user", content: results });
    if (round === MAX_TOOL_ROUNDS - 1) reply ||= "I found a lot to go through. Tell me which part to look at next.";
  }

  const reaction = await reacting;
  usage.micros += reaction.micros;
  const entry: UiEntry & { role: "assistant" } = {
    role: "assistant",
    text: reply || "Done.",
    cards: ctx.cards.slice(0, 30),
    added: ctx.added,
    ...(ctx.kit ? { kit: ctx.kit } : {}),
    at: new Date().toISOString(),
  };
  ui.push(
    { role: "user", text, ...(images.length ? { images: images.map((i) => i.id) } : {}), ...(reaction.emoji ? { reaction: reaction.emoji } : {}), at: sentAt },
    entry,
  );
  await prisma.assistantChat.update({
    where: { id: chat.id },
    data: {
      messagesJson: JSON.stringify(messages),
      uiJson: JSON.stringify(ui),
      userTurns: turns + 1,
      inputTokens: { increment: usage.in },
      outputTokens: { increment: usage.out },
    },
  });
  // Fetch the likely buys in the background so "Add" and "Add entire kit" are near-instant.
  prewarmProducts([...(ctx.kit?.items.map((i) => i.pid) ?? []), ...firstPickPerPart(ctx.cards), ...ctx.cards.map((c) => c.pid)]);
  // What this message cost us (planner and scouts), for per-plan AI budgets.
  return { entry, costMicros: usage.micros, reaction: reaction.emoji };
}

function firstPickPerPart(cards: ProductCard[]): string[] {
  const seen = new Set<string>();
  return cards.filter((c) => (seen.has(c.group ?? "") ? false : (seen.add(c.group ?? ""), true))).map((c) => c.pid);
}
