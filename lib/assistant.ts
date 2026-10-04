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
import { loadCart } from "@/lib/cart";
import { stockLabel, stockStatus } from "@/lib/inventory";
import { addKitToCart, type Kit, type KitItem } from "@/lib/kit";
import { bulkPricingLabel, priceOrder } from "@/lib/volume";

// Planner: Claude Sonnet 5.5 ($2 / $10 per MTok) at medium effort. Scouts: Claude Haiku 4.5 ($1 / $5).
const MODEL = process.env.ASSISTANT_MODEL?.trim() || "claude-sonnet-5-5";
const SCOUT_MODEL = process.env.ASSISTANT_SCOUT_MODEL?.trim() || "claude-haiku-4-5";
const EFFORT = (process.env.ASSISTANT_EFFORT?.trim() || "medium") as "low" | "medium" | "high";
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
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; cards: ProductCard[]; added: string[]; kit?: Kit };

/** Live events for the chat panel while a turn runs. */
export type AssistantEvent = { type: "progress"; note: string } | { type: "found"; group: string; cards: ProductCard[]; done: boolean };

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
- Prices are USD per unit and already include our margin. ${bulkPricingLabel()}; the cart applies it to the whole order. Prices you quote are list prices, so say the cart total will be lower for bulk orders, and use view_cart for the real total. Shipping is quoted for the shopper's postal code in the cart. For bulk quantities, add the quantity they need; stock is re-checked live.
- After you present picks for a project, call propose_kit once with your recommended pick for each part you found (sensible quantities; an option in words when it matters, e.g. "20Ah"). The shopper sees it as a kit card with an "Add entire kit" button.
- When the shopper asks to add the whole kit, everything, or all of it, call add_kit in the same turn with the kit's items (adjusted for anything they changed). Don't ask again; afterwards, list what was added and anything that failed.
- Be concise: a short intro, then the picks per part as a bullet list with name and price, then any questions. The shopper sees photo cards for every shortlisted product, so don't paste links.`;
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
      },
      required: ["parts"],
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
    name: "view_cart",
    description: "Show what is in the shopper's cart now, with quantities and the subtotal.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

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

interface Part {
  name: string;
  need: string;
  queries: string[];
}
interface ScoutResult {
  part: string;
  picks: Array<{ pid: string; title: string; from_price_usd: string; note: string }>;
}

async function scout(client: Anthropic, part: Part, emit: (e: AssistantEvent) => void, usage: { in: number; out: number }): Promise<ScoutResult> {
  const seen = new Map<string, CatalogHit>();
  const search = async (q: string) => {
    const query = q.trim().slice(0, 80);
    if (!query) return [];
    emit({ type: "progress", note: `${part.name}: searching “${query}”…` });
    const { hits } = await searchCatalog(query, 1);
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
async function runScouts(client: Anthropic, parts: Part[], emit: (e: AssistantEvent) => void, usage: { in: number; out: number }) {
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
  usage: { in: number; out: number };
}

async function runTool(name: string, input: Record<string, unknown>, ctx: Ctx): Promise<{ content: string; isError?: boolean }> {
  if (name === "find_products") {
    const parts = (Array.isArray(input.parts) ? input.parts : [])
      .slice(0, MAX_PARTS)
      .map((p) => {
        const o = p as Record<string, unknown>;
        const queries = (Array.isArray(o.queries) ? o.queries : []).map((q) => String(q)).filter(Boolean).slice(0, 3);
        return { name: String(o.name ?? "Item").slice(0, 40), need: String(o.need ?? "").slice(0, 300), queries: queries.length ? queries : [String(o.name ?? "")] };
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
      include: { offer: { include: { cjSupplierVariant: { select: { inventoryTotal: true } } } } },
    });
    return {
      content: JSON.stringify({
        title: product.title,
        options: variants
          .filter((v) => v.offer)
          .map((v) => ({
            variant_id: v.id,
            option: v.name,
            price_usd: (v.priceCents / 100).toFixed(2),
            stock: stockLabel(stockStatus(v.offer?.cjSupplierVariant.inventoryTotal)),
          })),
        description: product.description.slice(0, 1500),
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
      }),
    };
  }
  return { content: `Unknown tool ${name}.`, isError: true };
}

export class AssistantLimitError extends Error {}

/** One shopper turn: runs the planner's tool loop to completion and returns what the chat panel should show. */
export async function chatTurn(
  chatId: string,
  cartId: string,
  userText: string,
  emit: (e: AssistantEvent) => void = () => {},
): Promise<UiEntry & { role: "assistant" }> {
  const text = userText.trim().slice(0, MAX_MESSAGE_CHARS);
  const chat = await prisma.assistantChat.findUniqueOrThrow({ where: { id: chatId } });
  if (chat.userTurns >= MAX_USER_TURNS) throw new AssistantLimitError("This chat is full. Start a new one to keep going.");

  // History is append-only: thinking and fallback blocks must go back to the API exactly as received.
  const messages = JSON.parse(chat.messagesJson) as Anthropic.Beta.BetaMessageParam[];
  messages.push({ role: "user", content: text });
  const client = new Anthropic();
  const usage = { in: 0, out: 0 };
  const known = new Map<string, ProductCard>();
  for (const e of JSON.parse(chat.uiJson) as UiEntry[]) if (e.role === "assistant") for (const c of e.cards) known.set(c.pid, c);
  const ctx: Ctx = { cartId, cards: [], known, added: [], emit, client, usage };
  const haikuPlanner = MODEL.startsWith("claude-haiku");
  let reply = "";

  emit({ type: "progress", note: "Planning your parts list…" });
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: systemPrompt(),
      tools: PLANNER_TOOLS,
      cache_control: { type: "ephemeral" },
      messages,
      // Effort and refusal fallbacks are Sonnet/Opus features; Haiku rejects them.
      ...(haikuPlanner ? {} : { output_config: { effort: EFFORT }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    });
    usage.in += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    usage.out += response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });
    reply = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason === "refusal") reply = "Sorry, I can't help with that one.";
      break;
    }
    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
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

  const entry: UiEntry & { role: "assistant" } = { role: "assistant", text: reply || "Done.", cards: ctx.cards.slice(0, 30), added: ctx.added, ...(ctx.kit ? { kit: ctx.kit } : {}) };
  const ui = JSON.parse(chat.uiJson) as UiEntry[];
  ui.push({ role: "user", text }, entry);
  await prisma.assistantChat.update({
    where: { id: chat.id },
    data: {
      messagesJson: JSON.stringify(messages),
      uiJson: JSON.stringify(ui),
      userTurns: { increment: 1 },
      inputTokens: { increment: usage.in },
      outputTokens: { increment: usage.out },
    },
  });
  // Fetch the likely buys in the background so "Add" and "Add entire kit" are near-instant.
  prewarmProducts([...(ctx.kit?.items.map((i) => i.pid) ?? []), ...firstPickPerPart(ctx.cards)]);
  return entry;
}

function firstPickPerPart(cards: ProductCard[]): string[] {
  const seen = new Set<string>();
  return cards.filter((c) => (seen.has(c.group ?? "") ? false : (seen.add(c.group ?? ""), true))).map((c) => c.pid);
}
