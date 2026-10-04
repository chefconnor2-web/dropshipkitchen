// Sourcing assistant: a shopper describes a project ("battery setup for a custom e-bike") and a small,
// cheap Claude model plans the parts list, searches CJ's live catalog, and adds what they approve to
// their cart. Manual tool loop, server-side only; the model never sees supplier ids beyond the CJ PID.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { searchCatalog } from "@/lib/catalog-search";
import { openCjProduct } from "@/lib/open-product";
import { addVariantToCart } from "@/lib/cart-add";
import { loadCart } from "@/lib/cart";
import { stockLabel, stockStatus } from "@/lib/inventory";

// Claude Haiku 4.5: the cheapest current Claude model ($1 / $5 per million tokens). Override with ASSISTANT_MODEL.
const MODEL = process.env.ASSISTANT_MODEL?.trim() || "claude-haiku-4-5";
const MAX_TOOL_ROUNDS = 8;
const MAX_USER_TURNS = 40;
const MAX_MESSAGE_CHARS = 1000;

export function assistantConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

export interface ProductCard {
  pid: string;
  title: string;
  fromCents: number;
}
export type UiEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; cards: ProductCard[]; added: string[] };

function systemPrompt(): string {
  return `You are the sourcing assistant for ${config.storeName}, a Canadian B2B store where businesses and makers order almost anything from Chinese factories. Shoppers describe what they're building or need; you turn that into a concrete parts list, find real products in the catalog, and add the ones they approve to their cart.

How to work:
- First think about everything the project needs: the main components, the parts that connect them (wiring, connectors, mounts, fuses), and the tools to do it yourself. Briefly share that list.
- Find each item with search_catalog. The catalog search matches keywords, so use short queries of 1-3 plain words ("hub motor kit", "48v battery", "crimping tool"), not sentences. Search several items in parallel when you can.
- Only recommend products that came back from search_catalog, with the price it returned. Never invent products, prices, specs or delivery times. If nothing suitable comes back, try one or two other keyword phrasings (for example "xt90 plug", "xt90 connector male female"), then say it's not available and offer an alternative from this catalog. Never send shoppers to other stores or websites.
- While planning, only use search_catalog; don't open products yet. Call get_product only for the items you're about to add (and to check a spec you need).
- When the shopper says to add something, add it in the same turn: call get_product, then add_to_cart with the exact variant_id. Don't ask for confirmation again. If they asked you to build the whole cart, add your clear picks and list what you added. Otherwise add only what they asked for or agreed to.
- Prices are in USD per unit and already include our margin. Shipping is quoted for their postal code in the cart. For bulk or wholesale quantities, add the quantity they need; stock is re-checked live.
- Match parts to each other: voltage, connectors, sizes and wattage must be compatible. Point out anything the shopper must confirm (for example battery voltage matching the motor controller).
- Batteries and chargers must match exactly in chemistry and charge voltage. A "48V" Li-ion (NMC, 13S) pack charges at 54.6V; a "48V" LiFePO4 (16S) pack charges at 58.4V. Never pair a LiFePO4 charger with a Li-ion pack or the reverse: it can overcharge and start a fire. Read get_product's description to confirm both. If you can't confirm a match, say so and don't add the charger.
- Before adding an accessory, check the main product's description for what's included (charger, BMS, connectors, mounts) and don't add duplicates; tell the shopper what's already in the box.
- For lithium batteries, high voltage or mains wiring, add one short safety note (correct charger, a BMS, a fuse, insulated tools). Don't help with anything illegal or dangerous.
- Be concise: short paragraphs or bullet lists, no filler. Product cards with photos are shown to the shopper automatically for every search result, so refer to products by name rather than pasting long lists of links.`;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_catalog",
    description:
      "Keyword search over the supplier's live catalog of millions of products shipped from China. Returns products with an id (pid), title and starting price in USD. Use 1-3 word queries.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Short keyword query, e.g. 'brushless hub motor'" },
        limit: { type: "integer", description: "How many results to return, 1-10" },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "get_product",
    description:
      "Load one product's purchasable options (variants) with each option's variant_id, price and stock. Call before add_to_cart.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { pid: { type: "string", description: "The pid from search_catalog" } },
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
    name: "view_cart",
    description: "Show what is in the shopper's cart now, with quantities and the subtotal.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

interface Ctx {
  cartId: string;
  cards: ProductCard[];
  added: string[];
}

async function runTool(name: string, input: Record<string, unknown>, ctx: Ctx): Promise<{ content: string; isError?: boolean }> {
  if (name === "search_catalog") {
    const query = String(input.query ?? "").trim().slice(0, 80);
    const limit = Math.max(1, Math.min(10, Number(input.limit) || 6));
    if (!query) return { content: "Empty query.", isError: true };
    const { hits } = await searchCatalog(query, 1);
    const top = hits.slice(0, limit);
    for (const h of top) if (!ctx.cards.some((c) => c.pid === h.pid)) ctx.cards.push(h);
    if (!top.length) return { content: `No products found for "${query}". Try other keywords.` };
    return { content: JSON.stringify(top.map((h) => ({ pid: h.pid, title: h.title, from_price_usd: (h.fromCents / 100).toFixed(2) }))) };
  }
  if (name === "get_product") {
    const product = await openCjProduct(String(input.pid ?? ""));
    if (!product) return { content: "That product isn't available. Pick another search result.", isError: true };
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
        description: product.description.slice(0, 1200),
      }),
    };
  }
  if (name === "add_to_cart") {
    const quantity = Math.max(1, Math.min(999, Number(input.quantity) || 1));
    const r = await addVariantToCart(ctx.cartId, String(input.variant_id ?? ""), quantity);
    if (r.ok) ctx.added.push(r.message.replace(/^Added /, "").replace(/ to your cart\.$/, ""));
    return { content: r.message, isError: !r.ok };
  }
  if (name === "view_cart") {
    const cart = await loadCart(ctx.cartId);
    const items = cart?.items ?? [];
    if (!items.length) return { content: "The cart is empty." };
    const subtotal = items.reduce((n, i) => n + i.variant.priceCents * i.quantity, 0);
    return {
      content: JSON.stringify({
        items: items.map((i) => ({ title: i.variant.product.title, option: i.variant.name, quantity: i.quantity, line_total_usd: (i.variant.priceCents * i.quantity / 100).toFixed(2) })),
        subtotal: formatMoney(subtotal),
      }),
    };
  }
  return { content: `Unknown tool ${name}.`, isError: true };
}

export class AssistantLimitError extends Error {}

function progressNote(c: Anthropic.ToolUseBlock): string {
  const i = c.input as Record<string, unknown>;
  if (c.name === "search_catalog") return `Searching “${String(i.query ?? "").slice(0, 60)}”…`;
  if (c.name === "get_product") return "Checking options and stock…";
  if (c.name === "add_to_cart") return "Adding to your cart…";
  return "Checking your cart…";
}

/** One shopper turn: runs the tool loop to completion and returns what the chat panel should show. */
export async function chatTurn(
  chatId: string,
  cartId: string,
  userText: string,
  onProgress: (note: string) => void = () => {},
): Promise<UiEntry & { role: "assistant" }> {
  const text = userText.trim().slice(0, MAX_MESSAGE_CHARS);
  const chat = await prisma.assistantChat.findUniqueOrThrow({ where: { id: chatId } });
  if (chat.userTurns >= MAX_USER_TURNS) throw new AssistantLimitError("This chat is full. Start a new one to keep going.");

  const messages = JSON.parse(chat.messagesJson) as Anthropic.MessageParam[];
  messages.push({ role: "user", content: text });
  const ctx: Ctx = { cartId, cards: [], added: [] };
  const client = new Anthropic();
  let inTok = 0;
  let outTok = 0;
  let reply = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt(),
      tools: TOOLS,
      cache_control: { type: "ephemeral" },
      messages,
    });
    inTok += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
    outTok += response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });
    reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason === "refusal") reply = "Sorry, I can't help with that one.";
      break;
    }
    const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    for (const c of calls) onProgress(progressNote(c));
    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
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

  const entry: UiEntry & { role: "assistant" } = { role: "assistant", text: reply || "Done.", cards: ctx.cards.slice(0, 24), added: ctx.added };
  const ui = JSON.parse(chat.uiJson) as UiEntry[];
  ui.push({ role: "user", text }, entry);
  await prisma.assistantChat.update({
    where: { id: chat.id },
    data: {
      messagesJson: JSON.stringify(messages),
      uiJson: JSON.stringify(ui),
      userTurns: { increment: 1 },
      inputTokens: { increment: inTok },
      outputTokens: { increment: outTok },
    },
  });
  return entry;
}
