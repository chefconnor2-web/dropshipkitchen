// Amazon through a live browser: Neon searches Amazon, opens products and adds them to the cart in a real
// Chrome (the browser service), and the chat shows that browser live. Neon's browser is never signed in: it
// fills a guest cart, and at the end shows one "Check out on Amazon" link (Amazon's add-to-cart URL) that the
// shopper opens in their own Safari or Amazon app, where they're already signed in, so the items land in THEIR
// cart. When Amazon asks to sign in, Neon goes back and carries on as a guest; the shopper only takes over for
// a robot check or a choice only they can make. Neon never types passwords, addresses or card details and never
// places orders. On by setting the browser service variables (see lib/browser.ts). CONTRACTS.md §7 and §11.

import type Anthropic from "@anthropic-ai/sdk";
import type { BrowserCard, CartLinkCard } from "@/lib/flights-shared";
import { prisma } from "@/lib/db";
import { getShipTo } from "@/lib/cart";
import { processSingleton } from "@/lib/singleton";
import { BrowserError, browserApi, browserConfigured, chatBrowserId, forgetChatBrowser, inBrowser, isBusy, type PageState } from "@/lib/browser";
import type { PendingKind } from "@/lib/run-shared";
import type { Connector, ConnectorContext, ToolResult } from "./types";

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Where this chat's Amazon order goes: a place Neon set for it (e.g. the hotel, with amazon_set_location), else
 * the shopper's ship-to (their saved address). Picks the Amazon site and the "Deliver to" postal code.
 */
const chatPlaces = processSingleton("amazon-chat-places", () => new Map<string, { postal: string; country: string; label?: string }>());
async function deliverPlace(chatId: string): Promise<{ postal: string; country: string; label?: string }> {
  const set = chatPlaces.get(chatId);
  if (set) return set;
  const to = await getShipTo().catch(() => ({ country: "CA", zip: "" }));
  return { postal: to.zip ?? "", country: to.country };
}
async function amazonDomain(chatId: string): Promise<string> {
  return (await deliverPlace(chatId)).country === "CA" ? "amazon.ca" : "amazon.com";
}
// Browser sessions whose "Deliver to" is already set, and to what (session id → postal code).
const locatedTo = processSingleton("amazon-located", () => new Map<string, string>());
// Tries per chat and place: Amazon's first load in a new browser often fails, so one more, then leave it.
const locateTries = processSingleton("amazon-locate-tries", () => new Map<string, number>());

/* ---------- The cart link (pure; unit-tested in tests/amazon-cart-link.test.ts) ---------- */

export interface CartLine {
  asin: string;
  quantity: number;
}

const ASIN = /^[A-Z0-9]{10}$/;
export const MAX_LINK_PRODUCTS = 30;
export const MAX_LINK_QUANTITY = 30;

/**
 * Amazon's add-to-cart link for these products: opened by a signed-in shopper, it puts every item in their own
 * cart (Amazon asks them to confirm). Repeated ASINs are merged; lines with a bad ASIN or quantity are left out
 * and listed in `skipped`; a quantity above 30 is capped at 30; at most 30 products. Null when nothing is left.
 */
export function amazonCartLink(
  domain: string,
  lines: readonly CartLine[],
): { url: string; products: number; units: number; lines: CartLine[]; skipped: string[] } | null {
  if (domain !== "amazon.ca" && domain !== "amazon.com") return null;
  const merged = new Map<string, number>();
  const skipped: string[] = [];
  for (const l of lines) {
    const asin = String(l?.asin ?? "").trim().toUpperCase();
    const q = Number(l?.quantity);
    if (!ASIN.test(asin) || !Number.isInteger(q) || q < 1 || (!merged.has(asin) && merged.size >= MAX_LINK_PRODUCTS)) {
      skipped.push(asin || "(no ASIN)");
      continue;
    }
    merged.set(asin, Math.min(MAX_LINK_QUANTITY, (merged.get(asin) ?? 0) + q));
  }
  if (!merged.size) return null;
  const query = new URLSearchParams();
  const out: CartLine[] = [];
  for (const [asin, quantity] of merged) {
    out.push({ asin, quantity });
    query.append(`ASIN.${out.length}`, asin);
    query.append(`Quantity.${out.length}`, String(quantity));
  }
  return { url: `https://www.${domain}/gp/aws/cart/add.html?${query}`, products: out.length, units: out.reduce((n, l) => n + l.quantity, 0), lines: out, skipped };
}

/* ---------- What Neon put in the cart in each chat (kept across turns) ---------- */

export interface ChatCart {
  /**
   * By ASIN: added in Neon's browser or read from its cart (inCart), or kept for the link after Amazon asked to
   * sign in before it went in (not inCart). `session` is the browser it went into ("" when rebuilt from history).
   */
  lines: Map<string, { quantity: number; domain: string; session: string; title?: string; inCart: boolean; delivery?: string }>;
  /** How many times Amazon asked to sign in while adding each ASIN (after the second, Neon stops retrying). */
  signInAsks: Map<string, number>;
}

export const newChatCart = (): ChatCart => ({ lines: new Map(), signInAsks: new Map() });

/** amazon_add_to_cart worked: Amazon adds to what's there, so the quantities add up (in the same browser). */
export function noteAdded(c: ChatCart, domain: string, session: string, asin: string, quantity: number, title?: string, delivery?: string | null) {
  const a = asin.toUpperCase();
  if (!ASIN.test(a)) return;
  const was = c.lines.get(a);
  const base = was?.inCart && was.domain === domain ? was.quantity : 0;
  c.lines.set(a, { quantity: base + Math.max(1, Math.floor(quantity) || 1), domain, session, title: title || was?.title, inCart: true, delivery: delivery || was?.delivery });
  c.signInAsks.delete(a);
}

/** Amazon asked to sign in before the item went in: keep it for the link (the shopper's own cart gets it). */
export function noteKept(c: ChatCart, domain: string, asin: string, quantity: number, title?: string) {
  const a = asin.toUpperCase();
  if (!ASIN.test(a)) return;
  const was = c.lines.get(a);
  if (was?.inCart && was.domain === domain) return;
  c.lines.set(a, { quantity: Math.max(1, Math.floor(quantity) || 1), domain, session: "", title: title || was?.title, inCart: false });
}

/**
 * amazon_view_cart read the cart: it's the truth for quantities. Items Neon added in that same browser and no
 * longer in it were removed (by the shopper or Amazon). An empty read is ignored (the page may not have loaded).
 */
export function noteCartRead(c: ChatCart, domain: string, session: string, items: ReadonlyArray<{ asin?: unknown; quantity?: unknown; title?: unknown }>) {
  const read = items.map((i) => ({ asin: String(i.asin ?? "").toUpperCase(), quantity: Number(i.quantity), title: typeof i.title === "string" ? i.title : undefined })).filter((i) => ASIN.test(i.asin));
  if (!read.length) return;
  if (session)
    for (const [asin, l] of c.lines) if (l.inCart && l.session === session && l.domain === domain && !read.some((i) => i.asin === asin)) c.lines.delete(asin);
  for (const i of read) {
    const was = c.lines.get(i.asin);
    c.lines.set(i.asin, { quantity: Number.isInteger(i.quantity) && i.quantity > 0 ? i.quantity : 1, domain, session, title: i.title || was?.title, inCart: true });
    c.signInAsks.delete(i.asin);
  }
}

/** The lines for the link on this Amazon site. */
export const cartLinesFor = (c: ChatCart, domain: string): CartLine[] => [...c.lines].filter(([, l]) => l.domain === domain).map(([asin, l]) => ({ asin, quantity: l.quantity }));

/**
 * Rebuilds a chat's cart from its saved model history (after a restart): the results of amazon_add_to_cart and
 * amazon_view_cart, in order. Reads from history never remove items (which browser they were in isn't saved).
 */
export function rebuildChatCart(messages: unknown, domain: string): ChatCart {
  const c = newChatCart();
  if (!Array.isArray(messages)) return c;
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const m of messages as Array<{ role?: unknown; content?: unknown }>) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (m.role === "assistant" && b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        calls.set(b.id, { name: b.name, input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown> });
        continue;
      }
      if (m.role !== "user" || b?.type !== "tool_result" || b.is_error) continue;
      const call = calls.get(String(b.tool_use_id));
      if (!call || (call.name !== "amazon_add_to_cart" && call.name !== "amazon_view_cart")) continue;
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as Array<{ type?: string; text?: string }>).find((x) => x?.type === "text")?.text : "";
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(text ?? "") as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!r || typeof r !== "object") continue;
      const site = typeof r.site === "string" ? r.site : domain;
      if (call.name === "amazon_add_to_cart") {
        const asin = String(r.asin ?? call.input.asin ?? "");
        const title = typeof r.title === "string" ? r.title : undefined;
        if (r.added === true) noteAdded(c, site, "", asin, Number(r.quantity) || Number(call.input.quantity) || 1, title, typeof r.delivery === "string" ? r.delivery : null);
        else if (r.keptForLink === true) noteKept(c, site, asin, Number(r.requestedQuantity) || Number(call.input.quantity) || 1, title);
      } else if (Array.isArray(r.items)) noteCartRead(c, site, "", r.items as Array<Record<string, unknown>>);
    }
  }
  return c;
}

// Browser sessions that have shown an Amazon page (their live card can appear).
const loaded = processSingleton("amazon-loaded-sessions", () => new Set<string>());

/**
 * The first Amazon load in a fresh browser often fails (Amazon's first response to a new browser). Try once
 * more, quietly, when the step threw or didn't land on an Amazon page; the shopper never sees the failed one.
 */
async function firstLoadRetry<T extends { result: PageState; session: { id: string } }>(step: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    const r = await step();
    if (loaded.has(r.session.id) || /^https:\/\/(www\.)?amazon\./i.test(r.result.url)) return r;
  } catch (e) {
    if (signal.aborted) throw e;
  }
  await new Promise((res) => setTimeout(res, 1500));
  return step();
}

// One cart per chat in this process, rebuilt from the chat's history when missing (a restart).
const carts = processSingleton("amazon-chat-carts", () => new Map<string, ChatCart>());
const MAX_CARTS = 500;

async function chatCart(chatId: string, domain: string): Promise<ChatCart> {
  const have = carts.get(chatId);
  if (have) {
    // Most recently used last, so the oldest goes first when the map is full.
    carts.delete(chatId);
    carts.set(chatId, have);
    return have;
  }
  const row = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { messagesJson: true } }).catch(() => null);
  let history: unknown = [];
  try {
    history = JSON.parse(row?.messagesJson ?? "[]");
  } catch {
    /* unreadable history: start empty */
  }
  const rebuilt = rebuildChatCart(history, domain);
  // Another tool call of the same round may have built it while we read.
  const raced = carts.get(chatId);
  if (raced) return raced;
  carts.set(chatId, rebuilt);
  while (carts.size > MAX_CARTS) carts.delete(carts.keys().next().value!);
  return rebuilt;
}

/* ---------- Tools ---------- */

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "amazon_search",
    description:
      "Search Amazon in the live browser the shopper is watching. Returns the top results with ASIN, title, price as shown, rating, review count, Prime and whether it's sponsored. Search one product at a time with plain keywords.",
    input_schema: { type: "object", properties: { query: { type: "string", description: 'Plain search words, e.g. "48v 20ah ebike battery".' } }, required: ["query"] },
  },
  {
    name: "amazon_add_to_cart",
    description:
      "Open an Amazon product by ASIN in the live browser and add it to the cart there (a guest cart: the browser is never signed in). Use an ASIN from amazon_search. Everything you add goes into the shopper's own Amazon cart through amazon_checkout_link.",
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
    name: "amazon_search_many",
    description:
      "Run several Amazon searches in one go, one after another in the live browser. Use it when the shopper wants several different products. Returns the top results for each search, like amazon_search.",
    input_schema: {
      type: "object",
      properties: { queries: { type: "array", items: { type: "string" }, maxItems: 8, description: "Plain search words, one per product." } },
      required: ["queries"],
    },
  },
  {
    name: "amazon_add_many",
    description:
      "Add several products to the cart in one go, one after another in the live browser. Use ASINs from your searches. Returns, for each, whether it went in.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          maxItems: 20,
          items: { type: "object", properties: { asin: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 30 } }, required: ["asin"] },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "amazon_set_location",
    description:
      "Set where this Amazon order is delivered (Amazon's \"Deliver to\"), so prices, Prime availability and delivery estimates are for that place: e.g. the shopper's hotel when shipping there. Also picks the Amazon site that ships there (amazon.ca for Canada, amazon.com otherwise). Their saved address is used automatically otherwise; call this only for somewhere else, before searching.",
    input_schema: {
      type: "object",
      properties: {
        postal_code: { type: "string", description: "e.g. 33139 or M5H 2N2" },
        country_code: { type: "string", description: "2-letter, e.g. US" },
        label: { type: "string", description: "Short name shown to the shopper, e.g. 'The Beach Inn, Miami Beach'" },
      },
      required: ["postal_code", "country_code"],
    },
  },
  {
    name: "amazon_checkout_link",
    description:
      'Show the shopper a "Check out on Amazon" button: one link that puts everything you added to the Amazon cart in this chat (same products and quantities) into the shopper\'s OWN Amazon cart, in their Safari or Amazon app where they\'re already signed in. They check out there. Call it once everything is added and you\'ve read the cart with amazon_view_cart. It never places an order.',
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "browser_act",
    description:
      "Control the live browser directly when the Amazon tools aren't enough (choose a size or color, open a section, scroll). Actions run in order, then you get a screenshot (1280×800 px, a desktop browser) to see the result. tap x/y are pixels on that screenshot (a click). Only Amazon pages open. Never open sign-in or checkout pages.",
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
      "Hand the live browser to the shopper for something only they can do: get past a robot check (captcha), or make a choice only they know on the page (e.g. which size or color). It opens full screen on their phone with your one-line message; your turn pauses here until they tap Approve & next, then you get the page as it is now and carry on in the same reply. Don't end your turn to wait. Never use it for signing in or checking out: the browser stays signed out, and the shopper checks out in their own Amazon with amazon_checkout_link.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["captcha", "choice"] },
        message: { type: "string", description: 'One short line for the banner, e.g. "Pick the color you want, then tap Approve & next."' },
      },
      required: ["reason", "message"],
    },
  },
];

function card(session: string, site: string, handoff?: string): BrowserCard {
  return { kind: "browser", id: `br_${session}`, session, site, ...(handoff ? { handoff } : {}), group: "Live browser" };
}

/** Amazon wants a sign-in on this page (Neon never signs in, and never hands that to the shopper). */
const isSignIn = (p: PageState) => !!p.signIn || /sign.?in/i.test(String(p.needsShopper ?? ""));

/** Page facts for the model, plus the screenshot when it needs to see the page. */
function pageResult(p: PageState, facts: Record<string, unknown>, withShot: boolean, note?: string): ToolResult {
  const notes: string[] = note ? [note] : [];
  if (p.needsShopper && !isSignIn(p))
    notes.push(
      "This page still shows a robot check (the shopper was asked and it wasn't cleared). Don't try to get past it yourself: call browser_hand_over with reason captcha and a one-line message, or stop and tell them.",
    );
  const text = JSON.stringify({ ...facts, page: { url: p.url, title: p.title }, ...(notes.length ? { important: notes.join(" ") } : {}) });
  if (!(withShot || p.captcha) || !p.screenshot) return { content: text };
  return {
    content: [
      { type: "text", text },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.screenshot } },
    ],
  };
}

const kindOf = (p: PageState): PendingKind => (p.captcha ? "captcha" : "blocked");

const STOPPED = "The shopper didn't finish that step in time, so you stopped waiting. End your turn: tell them in one line that you'll carry on when they say so.";
const AS_GUEST =
  "Amazon asked to sign in. Your browser never signs in and you never ask the shopper to sign in or check out in it (they check out in their own Amazon with amazon_checkout_link), so you went back and carried on as a guest.";

async function run(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult> {
  const domain = await amazonDomain(ctx.chatId);
  /** Sets Amazon's "Deliver to" for this chat's place once per browser, before the first search or add. */
  const locate = async (force = false): Promise<{ located: boolean; deliverTo: string } | null> => {
    const place = await deliverPlace(ctx.chatId);
    if (!place.postal) return null;
    const sid = await chatBrowserId(ctx.chatId);
    if (!force && sid && locatedTo.get(sid) === place.postal) return null;
    const key = `${ctx.chatId}|${place.postal}`;
    const tries = locateTries.get(key) ?? 0;
    if (!force && tries >= 2) return null;
    locateTries.set(key, tries + 1);
    if (locateTries.size > 1000) locateTries.delete(locateTries.keys().next().value!);
    try {
      ctx.progress(`Setting Amazon's delivery location to ${place.label ?? place.postal}…`);
      const { result, session } = await inBrowser(ctx.chatId, (id) => browserApi.location(id, domain, place.postal, signal), signal);
      locatedTo.set(session.id, place.postal);
      return { located: !!result.located, deliverTo: result.deliverTo ?? "" };
    } catch (e) {
      if (signal.aborted) throw e;
      return null;
    }
  };
  const site = domain;
  const signal = ctx.signal;
  const shown = (s: { id: string }, handoff?: string) => ctx.show("Live browser", [card(s.id, site, handoff)]);
  /** The live card appears only once an Amazon page has actually loaded (the first load often fails). */
  const showIfLoaded = (s: { id: string }, p: PageState) => {
    if (/^https:\/\/(www\.)?amazon\./i.test(p.url) || loaded.has(s.id)) {
      loaded.add(s.id);
      shown(s);
    }
  };

  /**
   * Pauses the run on a step only the shopper can do (a robot check, a choice). The card shows the reason while
   * the chat opens it full screen; when they tap Done (and the server accepts it) we read the page again.
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

  /** Leaves a sign-in page: back where it came from, or the store's front page if that is a sign-in page too. */
  const asGuest = async (): Promise<PageState | null> => {
    ctx.progress("Amazon asked to sign in: carrying on as a guest");
    try {
      let { result: p } = await inBrowser(ctx.chatId, (id) => browserApi.act(id, [{ type: "back" }], signal), signal);
      if (isSignIn(p)) ({ result: p } = await inBrowser(ctx.chatId, (id) => browserApi.act(id, [{ type: "goto", url: `https://www.${domain}/` }], signal), signal));
      return p;
    } catch (e) {
      if (signal.aborted) throw e;
      return null;
    }
  };
  /** The page left behind after going back, or just the note when the browser couldn't move. */
  const guestResult = (back: PageState | null, facts: Record<string, unknown>, next: string): ToolResult =>
    back ? pageResult(back, facts, false, `${AS_GUEST} ${next}`) : { content: JSON.stringify({ ...facts, important: `${AS_GUEST} ${next}` }) };

  try {
    if (tool === "amazon_set_location") {
      const postal = str(input.postal_code, 12).toUpperCase();
      const country = str(input.country_code, 2).toUpperCase();
      if (postal.length < 3 || !/^[A-Z]{2}$/.test(country)) return { content: "Give the postal code and the 2-letter country code.", isError: true };
      chatPlaces.set(ctx.chatId, { postal, country, label: str(input.label, 60) || undefined });
      const now = await amazonDomain(ctx.chatId);
      const r = await (async () => {
        const place = await deliverPlace(ctx.chatId);
        const { result } = await inBrowser(ctx.chatId, (id) => browserApi.location(id, now, place.postal, signal), signal);
        const sid = await chatBrowserId(ctx.chatId);
        if (sid) locatedTo.set(sid, place.postal);
        return result;
      })();
      return pageResult(
        r,
        { site: now, deliverTo: r.deliverTo ?? "", located: !!r.located },
        false,
        now !== domain ? `Amazon site for this order is now ${now} (it ships to ${country}). Search and add on ${now}.` : r.located ? undefined : "Amazon didn't show the new location; delivery estimates may be for another place. Carry on.",
      );
    }
    if (tool === "amazon_search") {
      await locate();
      const query = str(input.query, 200);
      if (!query) return { content: "Give me something to search for.", isError: true };
      ctx.progress(`Searching Amazon: ${query}`);
      const search = () => firstLoadRetry(() => inBrowser(ctx.chatId, (id) => browserApi.search(id, domain, query, signal), signal), signal);
      const again = "Run this search once more; if Amazon asks again, move on to the next item.";
      let { result: p, session } = await search();
      showIfLoaded(session, p);
      if (isSignIn(p)) return guestResult(await asGuest(), { site, query, results: [] }, again);
      if (p.needsShopper) {
        const after = await handOver(session, kindOf(p), p.needsShopper);
        if (after === "stopped") return { content: STOPPED };
        // Searching again is safe (it changes nothing).
        ({ result: p, session } = await search());
        if (isSignIn(p)) return guestResult(await asGuest(), { site, query, results: [] }, again);
      }
      const results = (p.results ?? []).map((r) => ({ asin: r.asin, title: r.title, price: r.price, rating: r.rating, reviews: r.reviews, prime: r.prime, sponsored: r.sponsored }));
      return pageResult(p, { site, query, results, note: results.length ? "Prices are as Amazon shows them right now, in the site's currency." : "No results read from the page." }, !results.length);
    }
    if (tool === "amazon_add_to_cart") {
      await locate();
      const asin = str(input.asin, 10).toUpperCase();
      const quantity = Math.max(1, Math.min(30, Number(input.quantity) || 1));
      const cart = await chatCart(ctx.chatId, domain);
      /** Amazon asked to sign in before the item went in: keep it for the link, and let the model retry once. */
      const signedOut = async (title?: unknown): Promise<ToolResult> => {
        noteKept(cart, domain, asin, quantity, typeof title === "string" ? title : undefined);
        const asks = (cart.signInAsks.get(asin) ?? 0) + 1;
        cart.signInAsks.set(asin, asks);
        const next =
          asks > 1
            ? "Amazon asked again, so don't retry this one: it's kept for the cart link, so it still goes into the shopper's own cart. Carry on with the other items, then finish with amazon_view_cart and amazon_checkout_link."
            : "Try amazon_add_to_cart for this ASIN once more. If Amazon asks to sign in again, don't retry: it's kept for the cart link either way.";
        return guestResult(await asGuest(), { site, asin, added: false, keptForLink: true, requestedQuantity: quantity }, next);
      };
      ctx.progress(`Adding to the Amazon cart…`);
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.add(id, domain, asin, quantity, signal), signal);
      showIfLoaded(session, p);
      if (p.added) noteAdded(cart, domain, session.id, asin, p.quantity ?? quantity, p.title, p.delivery);
      if (isSignIn(p) && !p.added) return await signedOut(p.title);
      if (p.needsShopper && !p.added) {
        const after = await handOver(session, kindOf(p), p.needsShopper);
        if (after === "stopped") return { content: STOPPED };
        if (isSignIn(after)) return await signedOut(p.title);
        // Adding isn't safe to repeat blindly: let the model check the cart first.
        return pageResult(after, { site, asin, added: "unknown" }, true, `${resumedNote} Check the cart with amazon_view_cart before adding this item again.`);
      }
      ctx.progress(p.added ? `✓ Added ${p.title ? str(p.title, 60) : asin}` : `✗ Couldn't add ${asin}`);
      const facts = { site, asin, added: !!p.added, title: p.title, price: p.price, delivery: p.delivery ?? null, quantity: p.quantity, requestedQuantity: p.requestedQuantity, reason: p.reason };
      // Added, then Amazon showed a sign-in page anyway: step back off it quietly.
      if (isSignIn(p)) return guestResult(await asGuest(), facts, "The item went in. Carry on.");
      return pageResult(p, facts, !p.added);
    }
    if (tool === "amazon_search_many") {
      await locate();
      const queries = (Array.isArray(input.queries) ? input.queries : []).map((q) => str(q, 200)).filter(Boolean).slice(0, 8);
      if (!queries.length) return { content: "Give me something to search for.", isError: true };
      ctx.progress(`Searching Amazon for ${queries.length} things…`);
      const { result: p, session } = await firstLoadRetry(() => inBrowser(ctx.chatId, (id) => browserApi.searchMany(id, domain, queries, signal), signal), signal);
      showIfLoaded(session, p);
      if (isSignIn(p)) await asGuest();
      const searches = (p.searches ?? []).map((x) => ({
        query: x.query,
        results: (x.results ?? []).map((r) => ({ asin: r.asin, title: r.title, price: r.price, rating: r.rating, reviews: r.reviews, prime: r.prime, sponsored: r.sponsored })),
        ...(x.captcha || x.needsShopper || x.error ? { blocked: true } : {}),
      }));
      const blocked = searches.filter((x) => x.blocked).map((x) => x.query);
      const note = blocked.length ? `These searches were blocked (a robot check or a page that didn't load): ${blocked.join("; ")}. Run each with amazon_search (a robot check is handed to the shopper there).` : undefined;
      return pageResult(p, { site, searches, note: "Prices are as Amazon shows them right now, in the site's currency." }, false, note);
    }
    if (tool === "amazon_add_many") {
      await locate();
      const items = (Array.isArray(input.items) ? input.items : [])
        .slice(0, 20)
        .map((o) => ({ asin: str((o as { asin?: unknown })?.asin, 10).toUpperCase(), quantity: Math.max(1, Math.min(30, Number((o as { quantity?: unknown })?.quantity) || 1)) }))
        .filter((o) => /^[A-Z0-9]{10}$/.test(o.asin));
      if (!items.length) return { content: "Give me ASINs from your searches to add.", isError: true };
      const cart = await chatCart(ctx.chatId, domain);
      ctx.progress(`Adding ${items.length} items…`);
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.addMany(id, domain, items, signal), signal);
      showIfLoaded(session, p);
      const results = p.items ?? [];
      for (const r of results) {
        if (r.added) noteAdded(cart, domain, session.id, r.asin, r.quantity ?? r.requestedQuantity, r.title, r.delivery);
        // Amazon asked to sign in before it went in: it still goes into the shopper's own cart via the link.
        else if (r.signIn) noteKept(cart, domain, r.asin, r.requestedQuantity, r.title);
      }
      if (isSignIn(p)) await asGuest();
      const added = results.filter((r) => r.added).length;
      ctx.progress(`✓ Added ${added} of ${items.length}`);
      const robot = results.filter((r) => !r.added && r.captcha).map((r) => r.asin);
      const failed = results.filter((r) => !r.added && !r.captcha && !r.signIn).map((r) => r.asin);
      const notes = [
        robot.length ? `A robot check stopped these: ${robot.join(", ")}. Add each with amazon_add_to_cart (the shopper is asked to get past the check there).` : "",
        failed.length ? `These didn't go in: ${failed.join(", ")} (see each reason). Retry one with amazon_add_to_cart only if the reason suggests it would work, or pick another listing.` : "",
      ].filter(Boolean);
      return pageResult(
        p,
        { site, added, of: items.length, results: results.map((r) => ({ asin: r.asin, added: r.added, title: r.title, price: r.price, delivery: r.delivery ?? null, quantity: r.quantity, keptForLink: !r.added && !!r.signIn, reason: r.reason ?? r.error })) },
        false,
        notes.join(" ") || undefined,
      );
    }
    if (tool === "amazon_view_cart") {
      ctx.progress("Checking the Amazon cart…");
      const cart = await chatCart(ctx.chatId, domain);
      const read = () => firstLoadRetry(() => inBrowser(ctx.chatId, (id) => browserApi.cart(id, domain, signal), signal), signal);
      const skip = "Skip reading the cart: call amazon_checkout_link, which is built from what you added in this chat.";
      let { result: p, session } = await read();
      showIfLoaded(session, p);
      if (isSignIn(p)) return guestResult(await asGuest(), { site, items: [] }, skip);
      if (p.needsShopper) {
        const after = await handOver(session, kindOf(p), p.needsShopper);
        if (after === "stopped") return { content: STOPPED };
        ({ result: p, session } = await read());
        if (isSignIn(p)) return guestResult(await asGuest(), { site, items: [] }, skip);
      }
      const items = p.items ?? [];
      noteCartRead(cart, domain, session.id, items);
      return pageResult(p, { site, items, subtotal: p.subtotal ?? null }, !items.length);
    }
    if (tool === "amazon_checkout_link") {
      const cart = await chatCart(ctx.chatId, domain);
      const link = amazonCartLink(domain, cartLinesFor(cart, domain));
      if (!link)
        return { content: "Nothing has been added to the Amazon cart in this chat yet, so there's no link to show. Add the items with amazon_add_to_cart first.", isError: true };
      const session = (await chatBrowserId(ctx.chatId)) ?? ctx.chatId;
      const items = link.lines.map((l) => {
        const line = cart.lines.get(l.asin);
        return { asin: l.asin, quantity: l.quantity, ...(line?.title ? { title: str(line.title, 120) } : {}), ...(line?.delivery ? { delivery: str(line.delivery, 120) } : {}) };
      });
      const linkCard: CartLinkCard = { kind: "cart-link", id: `cl_${session}`, url: link.url, site, products: link.products, units: link.units, items, group: "Amazon cart" };
      ctx.show("Amazon cart", [linkCard]);
      ctx.progress(`Amazon cart link ready: ${link.units} item${link.units === 1 ? "" : "s"}`);
      const otherSite = [...cart.lines.values()].filter((l) => l.domain !== domain).length;
      return {
        content: JSON.stringify({
          shown: "Check out on Amazon",
          site,
          products: link.products,
          units: link.units,
          items: link.lines.map((l) => {
            const line = cart.lines.get(l.asin);
            return { asin: l.asin, quantity: l.quantity, ...(line?.title ? { title: str(line.title, 120) } : {}), ...(line && !line.inCart ? { note: "Amazon asked to sign in before it went in your browser; the link still adds it." } : {}) };
          }),
          ...(link.skipped.length ? { left_out: link.skipped } : {}),
          ...(otherSite ? { other_site: `${otherSite} item(s) added on another Amazon site aren't in this link.` } : {}),
          tell_the_shopper:
            'Tell them to tap "Check out on Amazon": it opens Amazon in their own Safari or Amazon app, where they\'re already signed in, and puts these items in their own cart (Amazon may ask them to confirm). They review and check out there. Never place the order yourself, and never ask them to sign in or check out in your browser.',
        }),
      };
    }
    if (tool === "browser_act") {
      const actions = (Array.isArray(input.actions) ? input.actions : []).slice(0, 8);
      if (!actions.length) return { content: "No actions given.", isError: true };
      ctx.progress("Working in the browser…");
      const asGuestNext = "Carry on as a guest from this page; don't open sign-in or checkout pages.";
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.act(id, actions, signal), signal);
      showIfLoaded(session, p);
      if (isSignIn(p)) return guestResult(await asGuest(), { done: actions.length }, asGuestNext);
      if (p.needsShopper) {
        const after = await handOver(session, kindOf(p), p.needsShopper);
        if (after === "stopped") return { content: STOPPED };
        if (isSignIn(after)) return guestResult(await asGuest(), { done: actions.length }, asGuestNext);
        return pageResult(after, { done: actions.length }, true, resumedNote);
      }
      return pageResult(p, { done: actions.length }, true);
    }
    if (tool === "browser_hand_over") {
      const kind: PendingKind = input.reason === "captcha" ? "captcha" : "choice";
      const message = str(input.message, 160) || "Your turn: tap Done when you've finished.";
      // The browser closes after a while unused: check it's still there (and what it shows) before asking the
      // shopper to look at it. Never open a new, blank one just to hand it over.
      const closed = "The browser had closed (it closes after a few minutes unused), so there's nothing to hand over. Open the page again with the Amazon tools first, or carry on without the shopper.";
      const sessionId = await chatBrowserId(ctx.chatId);
      if (!sessionId) return { content: closed, isError: true };
      let now: PageState;
      try {
        now = await browserApi.state(sessionId, signal);
      } catch (e) {
        if (!(e instanceof BrowserError) || e.status !== 404) throw e;
        await forgetChatBrowser(ctx.chatId);
        return { content: closed, isError: true };
      }
      const session = { id: sessionId };
      const asGuestNext = "Don't hand sign-in to the shopper. Carry on as a guest, and finish with amazon_view_cart and amazon_checkout_link.";
      if (isSignIn(now)) return guestResult(await asGuest(), { handedBack: false }, asGuestNext);
      const after = await handOver(session, kind, message);
      if (after === "stopped") return { content: STOPPED };
      if (isSignIn(after)) return guestResult(await asGuest(), { handedBack: true }, asGuestNext);
      return pageResult(after, { handedBack: true }, true, "The shopper tapped Done. Carry on with the task from this page.");
    }
    return { content: `Unknown tool ${tool}.`, isError: true };
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof BrowserError) {
      if (isBusy(e))
        return {
          content: "The browser is still finishing an earlier step (after a stop that can take up to half a minute). Try the same tool once more; if it's still busy, tell the shopper you'll carry on in a moment. Don't hand over for this.",
          isError: true,
        };
      if (e.status === 409)
        return {
          content: "The shopper has taken control of the live browser. Don't call browser_hand_over for this: end your turn and tell them in one line that you'll carry on when they hand it back.",
          isError: true,
        };
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
- When the shopper asks for something from Amazon, or asks you to shop or fill a cart on Amazon, use the Amazon tools. They drive a real browser that appears in the chat, so the shopper watches you search and add things. The browser is never signed in: you fill a guest cart.
- Amazon's delivery location is set to the shopper's saved address automatically. When the order ships somewhere else (their hotel), call amazon_set_location with that place's postal code and country first (look the postal code up if you don't have it), so prices and delivery estimates are for it.
- One amazon_search per product, then pick the best match: relevance and specs first, then ratings and review count, prefer Prime, skip sponsored results unless they're clearly the best fit. Say why in a few words.
- Several products: search them all at once with amazon_search_many, then add them all with amazon_add_many (one call instead of many). One product, or a retry: amazon_search / amazon_add_to_cart.
- Add what the shopper wants (the right quantities). When everything is added, call amazon_view_cart and tell them what's in it and the subtotal Amazon shows, then call amazon_checkout_link. It shows a "Check out on Amazon" button that puts the same items in the shopper's own Amazon cart, in their Safari or Amazon app where they're already signed in; they check out there.
- Quote prices only as Amazon shows them in the results or cart, in that site's currency. Never invent them.
- If a product needs a choice (size, color, voltage) and the shopper said what they want, use browser_act to select it; if they didn't, ask, or hand the page over with browser_hand_over (reason choice).
- Never ask the shopper to sign in or to check out inside the live browser, never type a password, one-time code, card number or address, and never place an order. When Amazon asks to sign in, the tools go back and carry on as a guest; follow what their result says. Robot checks are handed to the shopper automatically, and browser_hand_over is only for a robot check or a choice only they can make. While it's handed over your turn pauses until they tap Approve & next, then you see the page and carry on in the same reply. Don't end your turn to wait.
- If a tool says the shopper has taken control of the browser, don't hand over: tell them you'll carry on when they hand it back.`,
  tools: TOOLS,
  run,
};
