// Amazon through a live browser: Neon searches Amazon, opens products and adds them to the cart in a real
// Chrome (the browser service), and the chat shows that browser live. The shopper watches, and takes over to
// solve a captcha, sign in to their own Amazon account and check out; Neon never types passwords, addresses
// or card details. On by setting the browser service variables (see lib/browser.ts).

import type Anthropic from "@anthropic-ai/sdk";
import type { BrowserCard } from "@/lib/flights-shared";
import { getShipTo } from "@/lib/cart";
import { BrowserError, browserApi, browserConfigured, inBrowser, type PageState } from "@/lib/browser";
import type { PendingKind } from "@/lib/run-shared";
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
      "Control the live browser directly when the Amazon tools aren't enough (choose a size or color, open a section, scroll). Actions run in order, then you get a screenshot (1280×800 px, a desktop browser) to see the result. tap x/y are pixels on that screenshot (a click). Only Amazon pages open.",
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
      "Hand the live browser to the shopper for something only they can do (solve a captcha, sign in, choose an option only they know, or check out). It opens full screen on their phone with your one-line message; your turn pauses here until they tap Done, then you get the page as it is now and carry on in the same reply. Don't end your turn to wait.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["captcha", "sign_in", "checkout", "choice"] },
        message: { type: "string", description: 'One short line for the banner, e.g. "Sign in to your Amazon account, then tap Done."' },
      },
      required: ["reason", "message"],
    },
  },
];

function card(session: string, site: string, handoff?: string): BrowserCard {
  return { kind: "browser", id: `br_${session}`, session, site, ...(handoff ? { handoff } : {}), group: "Live browser" };
}

/** Page facts for the model, plus the screenshot when it needs to see the page. */
function pageResult(p: PageState, facts: Record<string, unknown>, withShot: boolean, note?: string): ToolResult {
  const notes: string[] = note ? [note] : [];
  if (p.needsShopper)
    notes.push(
      "This page still needs the shopper (they were asked and it wasn't cleared). Don't try to get past it yourself and never type credentials: call browser_hand_over with a one-line message, or stop and tell them.",
    );
  const text = JSON.stringify({ ...facts, page: { url: p.url, title: p.title }, ...(notes.length ? { important: notes.join(" ") } : {}) });
  if (!(withShot || p.captcha || p.signIn) || !p.screenshot) return { content: text };
  return {
    content: [
      { type: "text", text },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.screenshot } },
    ],
  };
}

const kindOf = (p: PageState): PendingKind => (p.captcha ? "captcha" : p.signIn ? "sign_in" : "blocked");

const STOPPED = "The shopper didn't finish that step in time, so you stopped waiting. End your turn: tell them in one line that you'll carry on when they say so.";

async function run(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult> {
  const domain = await amazonDomain();
  const site = domain;
  const signal = ctx.signal;
  const shown = (s: { id: string }, handoff?: string) => ctx.show("Live browser", [card(s.id, site, handoff)]);

  /**
   * Pauses the run on a step only the shopper can do. The card shows the reason while the chat opens it full
   * screen; when they tap Done (and the server accepts it) we read the page again and carry on.
   */
  const handOver = async (s: { id: string }, kind: PendingKind, message: string): Promise<PageState | "stopped"> => {
    shown(s, message);
    const w = await ctx.waitForShopper({ kind, message, browser: { sessionId: s.id, cardId: `br_${s.id}` } });
    shown(s);
    if (w.outcome !== "resumed") return "stopped";
    ctx.progress("Back to Neon…");
    return (await inBrowser(ctx.chatId, (id) => browserApi.state(id, signal), signal)).result;
  };
  const resumedNote = "The shopper finished on the page and handed back; this is the page now. Carry on with the task.";

  try {
    if (tool === "amazon_search") {
      const query = str(input.query, 200);
      if (!query) return { content: "Give me something to search for.", isError: true };
      ctx.progress(`Searching Amazon: ${query}`);
      let { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.search(id, domain, query, signal), signal);
      shown(session);
      if (p.needsShopper) {
        const after = await handOver(session, kindOf(p), p.needsShopper);
        if (after === "stopped") return { content: STOPPED };
        // Searching again is safe (it changes nothing).
        ({ result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.search(id, domain, query, signal), signal));
      }
      const results = (p.results ?? []).map((r) => ({ asin: r.asin, title: r.title, price: r.price, rating: r.rating, reviews: r.reviews, prime: r.prime, sponsored: r.sponsored }));
      return pageResult(p, { site, query, results, note: results.length ? "Prices are as Amazon shows them right now, in the site's currency." : "No results read from the page." }, !results.length);
    }
    if (tool === "amazon_add_to_cart") {
      const asin = str(input.asin, 10).toUpperCase();
      const quantity = Math.max(1, Math.min(30, Number(input.quantity) || 1));
      ctx.progress(`Adding to the Amazon cart…`);
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.add(id, domain, asin, quantity, signal), signal);
      shown(session);
      if (p.needsShopper && !p.added) {
        const after = await handOver(session, kindOf(p), p.needsShopper);
        if (after === "stopped") return { content: STOPPED };
        // Adding isn't safe to repeat blindly: let the model check the cart first.
        return pageResult(after, { asin, added: "unknown" }, true, `${resumedNote} Check the cart with amazon_view_cart before adding this item again.`);
      }
      ctx.progress(p.added ? `✓ Added ${p.title ? str(p.title, 60) : asin}` : `✗ Couldn't add ${asin}`);
      return pageResult(p, { asin, added: !!p.added, title: p.title, price: p.price, quantity: p.quantity, requestedQuantity: p.requestedQuantity, reason: p.reason }, !p.added);
    }
    if (tool === "amazon_view_cart") {
      ctx.progress("Checking the Amazon cart…");
      let { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.cart(id, domain, signal), signal);
      shown(session);
      if (p.needsShopper) {
        const after = await handOver(session, kindOf(p), p.needsShopper);
        if (after === "stopped") return { content: STOPPED };
        ({ result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.cart(id, domain, signal), signal));
      }
      return pageResult(p, { site, items: p.items ?? [], subtotal: p.subtotal ?? null }, !(p.items ?? []).length);
    }
    if (tool === "browser_act") {
      const actions = (Array.isArray(input.actions) ? input.actions : []).slice(0, 8);
      if (!actions.length) return { content: "No actions given.", isError: true };
      ctx.progress("Working in the browser…");
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.act(id, actions, signal), signal);
      shown(session);
      if (p.needsShopper) {
        const after = await handOver(session, kindOf(p), p.needsShopper);
        if (after === "stopped") return { content: STOPPED };
        return pageResult(after, { done: actions.length }, true, resumedNote);
      }
      return pageResult(p, { done: actions.length }, true);
    }
    if (tool === "browser_hand_over") {
      const { session } = await inBrowser(ctx.chatId, async () => null, signal);
      const reason = String(input.reason ?? "choice");
      const kind: PendingKind = reason === "captcha" || reason === "sign_in" || reason === "checkout" ? reason : "choice";
      const message = str(input.message, 160) || "Your turn: tap Done when you've finished.";
      const after = await handOver(session, kind, message);
      if (after === "stopped") return { content: STOPPED };
      const next =
        kind === "checkout"
          ? "If they placed the order, thank them and stop; otherwise view the cart (amazon_view_cart) and summarize what's in it."
          : "Carry on with the task from this page.";
      return pageResult(after, { handedBack: true }, true, `The shopper tapped Done. ${next}`);
    }
    return { content: `Unknown tool ${tool}.`, isError: true };
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof BrowserError) {
      if (e.status === 409) return { content: `${e.message} The shopper is using the browser right now. Call browser_hand_over if you need them to finish something, or wait.`, isError: true };
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
- Never type a password, one-time code, card number or address, and never place the order. When Amazon asks to sign in, shows a captcha, or the cart is ready for checkout, call browser_hand_over (pages that need the shopper are handed over automatically). The browser opens full screen on their phone; your turn pauses until they tap Done, then you see the page and carry on in the same reply. Don't end your turn to wait.
- If the browser is busy because the shopper has control, call browser_hand_over or wait.`,
  tools: TOOLS,
  run,
};
