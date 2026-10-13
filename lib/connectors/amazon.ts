// Amazon through a live browser: Neon searches Amazon, opens products and adds them to the cart in a real
// Chrome (the browser service), and the chat shows that browser live. The shopper watches, and takes over to
// solve a captcha, sign in to their own Amazon account and check out; Neon never types passwords, addresses
// or card details. On by setting the browser service variables (see lib/browser.ts).

import type Anthropic from "@anthropic-ai/sdk";
import type { BrowserCard } from "@/lib/flights-shared";
import { getShipTo } from "@/lib/cart";
import { BrowserError, browserApi, browserConfigured, inBrowser, liveUrl, type PageState } from "@/lib/browser";
import type { Connector, ConnectorContext, ToolResult } from "./types";

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

async function amazonDomain(): Promise<string> {
  const to = await getShipTo().catch(() => ({ country: "CA" }));
  return to.country === "CA" ? "amazon.ca" : "amazon.com";
}

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "amazon_search",
    description:
      "Search Amazon in the live browser the shopper is watching. Returns the top results with ASIN, title, price as shown, rating, review count, Prime and whether it's sponsored. Search one product at a time with plain keywords.",
    input_schema: { type: "object", properties: { query: { type: "string", description: 'Plain search words, e.g. "48v 20ah ebike battery".' } }, required: ["query"] },
  },
  {
    name: "amazon_add_to_cart",
    description: "Open an Amazon product by ASIN in the live browser and add it to the Amazon cart. Use an ASIN from amazon_search.",
    input_schema: {
      type: "object",
      properties: { asin: { type: "string", description: "10-character Amazon product ID." }, quantity: { type: "integer", minimum: 1, maximum: 30 } },
      required: ["asin"],
    },
  },
  {
    name: "amazon_view_cart",
    description: "Open the Amazon cart in the live browser and read the items, quantities and subtotal.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_act",
    description:
      "Control the live browser directly when the Amazon tools aren't enough (choose a size or color, open a section, scroll). Actions run in order, then you get a screenshot (390×780 px) to see the result. tap x/y are pixels on that screenshot. Only Amazon pages open.",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["tap", "type", "key", "scroll", "back", "goto", "wait"] },
              x: { type: "number" },
              y: { type: "number" },
              text: { type: "string", description: "For type. Never a password, card number or address." },
              key: { type: "string", enum: ["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp"] },
              dy: { type: "number", description: "For scroll: pixels down (negative scrolls up)." },
              url: { type: "string", description: "For goto: an Amazon address." },
              ms: { type: "number" },
            },
            required: ["type"],
          },
        },
      },
      required: ["actions"],
    },
  },
  {
    name: "browser_hand_over",
    description:
      "Ask the shopper to take over the live browser: to solve a captcha, sign in, choose something only they can, or check out. Their card shows a 'Your turn' banner with your message. Then end your turn and tell them what to do.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["captcha", "sign_in", "checkout", "choice"] },
        message: { type: "string", description: 'One short line for the banner, e.g. "Solve the puzzle, then tell me to keep going."' },
      },
      required: ["reason", "message"],
    },
  },
];

function card(sessionLive: string, id: string, site: string, handoff?: string): BrowserCard {
  return { kind: "browser", id: `br_${id}`, live: sessionLive, site, ...(handoff ? { handoff } : {}), group: "Live browser" };
}

/** Page facts for the model, plus the screenshot when it needs to see the page. */
function pageResult(p: PageState, facts: Record<string, unknown>, withShot: boolean): ToolResult {
  const notes: string[] = [];
  if (p.captcha) notes.push("Amazon is showing a captcha. Call browser_hand_over with reason captcha, then tell the shopper to solve it and say when they're done.");
  if (p.signIn) notes.push("Amazon is asking to sign in. Never type credentials: call browser_hand_over with reason sign_in.");
  const text = JSON.stringify({ ...facts, page: { url: p.url, title: p.title }, ...(notes.length ? { important: notes.join(" ") } : {}) });
  if (!(withShot || p.captcha || p.signIn) || !p.screenshot) return { content: text };
  return {
    content: [
      { type: "text", text },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.screenshot } },
    ],
  };
}

async function run(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult> {
  const domain = await amazonDomain();
  const site = domain;
  const shown = (s: { id: string; viewToken: string }, handoff?: string) => ctx.show("Live browser", [card(liveUrl(s), s.id, site, handoff)]);
  try {
    if (tool === "amazon_search") {
      const query = str(input.query, 200);
      if (!query) return { content: "Give me something to search for.", isError: true };
      ctx.progress(`Searching Amazon: ${query}`);
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.search(id, domain, query));
      shown(session);
      const results = (p.results ?? []).map((r) => ({ asin: r.asin, title: r.title, price: r.price, rating: r.rating, reviews: r.reviews, prime: r.prime, sponsored: r.sponsored }));
      return pageResult(p, { site, query, results, note: results.length ? "Prices are as Amazon shows them right now, in the site's currency." : "No results read from the page." }, !results.length);
    }
    if (tool === "amazon_add_to_cart") {
      const asin = str(input.asin, 10).toUpperCase();
      const quantity = Math.max(1, Math.min(30, Number(input.quantity) || 1));
      ctx.progress(`Adding to the Amazon cart…`);
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.add(id, domain, asin, quantity));
      shown(session);
      ctx.progress(p.added ? `✓ Added ${p.title ? str(p.title, 60) : asin}` : `✗ Couldn't add ${asin}`);
      return pageResult(p, { asin, added: !!p.added, title: p.title, price: p.price, quantity: p.quantity, requestedQuantity: p.requestedQuantity, reason: p.reason }, !p.added);
    }
    if (tool === "amazon_view_cart") {
      ctx.progress("Checking the Amazon cart…");
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.cart(id, domain));
      shown(session);
      return pageResult(p, { site, items: p.items ?? [], subtotal: p.subtotal ?? null }, !(p.items ?? []).length);
    }
    if (tool === "browser_act") {
      const actions = (Array.isArray(input.actions) ? input.actions : []).slice(0, 8);
      if (!actions.length) return { content: "No actions given.", isError: true };
      ctx.progress("Working in the browser…");
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.act(id, actions));
      shown(session);
      return pageResult(p, { done: actions.length }, true);
    }
    if (tool === "browser_hand_over") {
      const { session } = await inBrowser(ctx.chatId, async () => null);
      const message = str(input.message, 160) || "Your turn: tap Take over.";
      shown(session, message);
      return { content: `The shopper sees "${message}" on the live browser with a Take over button. End your turn now: tell them in one or two lines what to do, and that you'll carry on when they tell you.` };
    }
    return { content: `Unknown tool ${tool}.`, isError: true };
  } catch (e) {
    if (e instanceof BrowserError) {
      if (e.status === 409) return { content: `${e.message} Wait for the shopper to hand control back (they tap Hand back), then try again.`, isError: true };
      return { content: e.message, isError: true };
    }
    throw e;
  }
}

export const amazonConnector: Connector = {
  id: "amazon",
  label: "Amazon (live browser)",
  enabled: browserConfigured,
  prompt: () => `
Amazon, in a live browser:
- When the shopper asks for something from Amazon, or asks you to shop or fill a cart on Amazon, use the Amazon tools. They drive a real browser that appears in the chat, so the shopper watches you search and add things.
- One amazon_search per product, then pick the best match: relevance and specs first, then ratings and review count, prefer Prime, skip sponsored results unless they're clearly the best fit. Say why in a few words.
- Add what the shopper wants with amazon_add_to_cart (the right quantity). Then amazon_view_cart and tell them what's in it and the subtotal Amazon shows.
- Quote prices only as Amazon shows them in the results or cart, in that site's currency. Never invent them.
- If a product needs a choice (size, color, voltage) and the shopper said what they want, use browser_act to select it; if they didn't, ask.
- Never type a password, one-time code, card number or address, and never place the order. When Amazon asks to sign in, shows a captcha, or the cart is ready for checkout, call browser_hand_over and stop: the shopper taps Take over, signs in to their own Amazon account (the cart comes with them) and checks out themselves.
- If the browser is busy because the shopper has control, wait for them.`,
  tools: TOOLS,
  run,
};
