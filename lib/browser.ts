// Client for the Chit browser service (browser-service/, its own Railway service): one live Chrome per chat
// that Neon drives and the shopper can watch and take over in the chat.
//
// BROWSER_SERVICE_URL     where the server reaches it (private network, e.g. http://chit-browser.railway.internal:8080)
// BROWSER_PUBLIC_URL      its public https address, for the live view in the shopper's browser
// BROWSER_SERVICE_SECRET  shared secret, set on both services
//
// Ownership: the chat row records its browser session (AssistantChat.browserSessionId). Live-view addresses
// carry a token that expires after 10 minutes and are minted on demand for the chat's owner only
// (GET /api/assistant/browser); they're never saved in the chat. See docs/frontier-port/CONTRACTS.md §3.

import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { processSingleton } from "@/lib/singleton";

export function browserConfigured(): boolean {
  return !!(process.env.BROWSER_SERVICE_SECRET?.trim() && (process.env.BROWSER_SERVICE_URL?.trim() || process.env.BROWSER_PUBLIC_URL?.trim()));
}

const serviceUrl = () => (process.env.BROWSER_SERVICE_URL?.trim() || process.env.BROWSER_PUBLIC_URL?.trim() || "").replace(/\/$/, "");
const secret = () => process.env.BROWSER_SERVICE_SECRET?.trim() ?? "";

export class BrowserError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown, method = "POST", signal?: AbortSignal, timeoutMs = 90_000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const r = await fetch(serviceUrl() + path, {
    method,
    headers: { "content-type": "application/json", "x-browser-secret": secret() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new BrowserError(data.error || `The browser service answered ${r.status}.`, r.status);
  return data;
}

export interface PageState {
  url: string;
  title: string;
  captcha: boolean;
  /** Amazon wants to sign in. Neon never does and never hands it over: it goes back and shops as a guest. */
  signIn: boolean;
  /** Set when the page blocks the step (robot check, sign in): what the service would tell the shopper. */
  needsShopper?: string | null;
  /** JPEG, base64, 1280×800 (desktop Chrome). */
  screenshot: string | null;
  [k: string]: unknown;
}

interface Session {
  id: string;
}

// Cache of chat → session for this process; the chat row is the source of truth.
const byChat = processSingleton("browser-sessions", () => new Map<string, Session>());
// A browser being opened for a chat: steps that arrive at the same time wait for it instead of opening another.
const opening = processSingleton("browser-opening", () => new Map<string, Promise<Session>>());
// Each chat's browser steps run one after another (the model may call two browser tools at once).
const queues = processSingleton("browser-queues", () => new Map<string, Promise<unknown>>());

/** A short-lived live-view address for this session (HMAC token, CONTRACTS.md §3). Server only. */
export function mintLiveUrl(sessionId: string, ttlSeconds = 600): { url: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = createHmac("sha256", secret()).update(`live.${sessionId}.${exp}`).digest("base64url");
  const pub = (process.env.BROWSER_PUBLIC_URL?.trim() || serviceUrl()).replace(/^http/, "ws").replace(/\/$/, "");
  return { url: `${pub}/live?id=${encodeURIComponent(sessionId)}&exp=${exp}&token=${token}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The live view's WebSocket origin (wss://…), for the Chit MCP view's connect-src; null when not set up. */
export function liveOrigin(): string | null {
  const pub = process.env.BROWSER_PUBLIC_URL?.trim() || serviceUrl();
  try {
    return pub ? new URL(pub.replace(/^http/, "ws")).origin : null;
  } catch {
    return null;
  }
}

async function remember(chatId: string, session: Session | null) {
  if (session) byChat.set(chatId, session);
  else byChat.delete(chatId);
  await prisma.assistantChat.update({ where: { id: chatId }, data: { browserSessionId: session?.id ?? null } }).catch(() => {});
}

export async function chatBrowser(chatId: string, signal?: AbortSignal): Promise<{ session: Session; created: boolean }> {
  const have = byChat.get(chatId);
  if (have) return { session: have, created: false };
  const row = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { browserSessionId: true } });
  if (row?.browserSessionId) {
    const s = { id: row.browserSessionId };
    byChat.set(chatId, s);
    return { session: s, created: false };
  }
  const pending = opening.get(chatId);
  if (pending) return { session: await pending, created: false };
  const open = (async () => {
    const created = await call<{ id: string }>("/sessions", undefined, "POST", signal);
    const session = { id: created.id };
    await remember(chatId, session);
    return session;
  })();
  opening.set(chatId, open);
  try {
    return { session: await open, created: true };
  } finally {
    if (opening.get(chatId) === open) opening.delete(chatId);
  }
}

/** The chat's browser session id, without opening a browser (null when it has none). */
export async function chatBrowserId(chatId: string): Promise<string | null> {
  const have = byChat.get(chatId);
  if (have) return have.id;
  const row = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { browserSessionId: true } }).catch(() => null);
  return row?.browserSessionId ?? null;
}

/** Forgets the chat's browser (the service said it has closed), so the next step opens a new one. */
export async function forgetChatBrowser(chatId: string): Promise<void> {
  await remember(chatId, null);
}

/** 409 because the service is still running the previous step (not because the shopper has control). */
export const isBusy = (e: unknown) => e instanceof BrowserError && e.status === 409 && /busy/i.test(e.message);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// After a Stop the service may still be finishing the old step (a page load runs up to 30 s): a step it refused
// as busy never ran, so it's safe to try again a little later.
const BUSY_RETRY_MS = [2_000, 4_000, 8_000];

async function stepWhenFree<T>(step: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await step();
    } catch (e) {
      if (!isBusy(e) || i >= BUSY_RETRY_MS.length) throw e;
      await sleep(BUSY_RETRY_MS[i], signal);
    }
  }
}

/** Runs a browser step for this chat, after any step already running for it, opening a browser if needed. */
export function inBrowser<T>(chatId: string, step: (id: string) => Promise<T>, signal?: AbortSignal): Promise<{ result: T; session: Session; created: boolean }> {
  const before = queues.get(chatId) ?? Promise.resolve();
  const mine = before.catch(() => {}).then(() => inBrowserNow(chatId, step, signal));
  const tail = mine.catch(() => {});
  queues.set(chatId, tail);
  void tail.then(() => queues.get(chatId) === tail && queues.delete(chatId));
  return mine;
}

async function inBrowserNow<T>(chatId: string, step: (id: string) => Promise<T>, signal?: AbortSignal): Promise<{ result: T; session: Session; created: boolean }> {
  let { session, created } = await chatBrowser(chatId, signal);
  try {
    return { result: await stepWhenFree(() => step(session.id), signal), session, created };
  } catch (e) {
    if (!(e instanceof BrowserError) || e.status !== 404) throw e;
    byChat.delete(chatId);
    await prisma.assistantChat.update({ where: { id: chatId }, data: { browserSessionId: null } }).catch(() => {});
    ({ session, created } = await chatBrowser(chatId, signal));
    return { result: await stepWhenFree(() => step(session.id), signal), session, created };
  }
}

// A batch (up to 20 items over a few tabs) can take minutes; single steps keep the 90 s limit.
const BATCH_MS = 5 * 60_000;

export const browserApi = {
  /** Runs actions in order; smart form actions (fill / select / date / click_text) each report what they did. */
  act: (id: string, actions: unknown[], signal?: AbortSignal, opts: { noShot?: boolean } = {}) =>
    call<PageState & { results?: Array<{ type: string; field?: string; text?: string; ok: boolean; did?: string; why?: string; fields?: string[] }> }>(
      `/sessions/${id}/act`,
      { actions, ...(opts.noShot ? { noShot: true } : {}) },
      "POST",
      signal,
    ),
  /** Reads any public page in its own fresh, signed-out browser: final URL, title, text and up to 3 screenshots. */
  read: (url: string, signal?: AbortSignal) =>
    call<{ url: string; title: string; text: string; truncated: boolean; screenshots: string[] }>(`/read`, { url }, "POST", signal, 45_000),
  /** Opens a link in a fresh, signed-out browser (as the shopper's own would) and says where it lands. */
  probe: (id: string, url: string, signal?: AbortSignal) =>
    call<{ url: string; title: string; kind: "confirmed" | "payment" | "driver" | "offer" | "search" | "other"; number: string | null }>(`/sessions/${id}/probe`, { url }, "POST", signal),
  /** Claude's browser use toolset: member calls run in order, stopping at the first failure. */
  tool: (id: string, calls: Array<{ name: string; input: unknown }>, signal?: AbortSignal) =>
    call<{ results: Array<{ content: unknown[]; isError?: boolean }>; url: string; title: string; needsShopper?: string | null }>(`/sessions/${id}/browser-tool`, { calls }, "POST", signal),
  state: (id: string, signal?: AbortSignal) => call<PageState>(`/sessions/${id}/state`, undefined, "GET", signal),
  search: (id: string, domain: string, query: string, signal?: AbortSignal) =>
    call<PageState & { results?: AmazonResult[] }>(`/sessions/${id}/amazon/search`, { domain, query }, "POST", signal),
  add: (id: string, domain: string, asin: string, quantity: number, signal?: AbortSignal) =>
    call<PageState & { added?: boolean; title?: string; price?: string | null; delivery?: string | null; quantity?: number; requestedQuantity?: number; reason?: string }>(
      `/sessions/${id}/amazon/add`,
      { domain, asin, quantity },
      "POST",
      signal,
    ),
  /** Several searches at once, in parallel tabs of the same browser. */
  searchMany: (id: string, domain: string, queries: string[], signal?: AbortSignal) =>
    call<PageState & { searches?: Array<{ query: string; results: AmazonResult[]; captcha?: boolean; signIn?: boolean; needsShopper?: string | null; error?: string }> }>(
      `/sessions/${id}/amazon/search-many`,
      { domain, queries },
      "POST",
      signal,
      BATCH_MS,
    ),
  /** Several products added at once, in parallel tabs of the same browser (one guest cart). */
  addMany: (id: string, domain: string, items: Array<{ asin: string; quantity: number }>, signal?: AbortSignal) =>
    call<
      PageState & {
        items?: Array<{ asin: string; added: boolean; title?: string; price?: string | null; delivery?: string | null; quantity?: number; requestedQuantity: number; reason?: string; captcha?: boolean; signIn?: boolean; error?: string }>;
      }
    >(`/sessions/${id}/amazon/add-many`, { domain, items }, "POST", signal, BATCH_MS),
  /** Amazon's "Deliver to": prices and delivery estimates for this postal code. */
  location: (id: string, domain: string, postal: string, signal?: AbortSignal) =>
    call<PageState & { located?: boolean; deliverTo?: string }>(`/sessions/${id}/amazon/location`, { domain, postal }, "POST", signal),
  cart: (id: string, domain: string, signal?: AbortSignal) =>
    call<PageState & { items?: Array<{ asin: string; title: string; quantity: number | null; price: string | null }>; subtotal?: string | null }>(
      `/sessions/${id}/amazon/cart`,
      { domain },
      "POST",
      signal,
    ),
};

/**
 * Dev sessions: Chit's browser as a development assistant for coding agents (Claude Code and others, via the
 * MCP dev_* tools). Unlike shopping sessions they may open any PUBLIC site (never localhost or private
 * addresses), and they record console errors, exceptions and failed requests for GET /sessions/:id/devlog.
 */
export interface DevLogEntry {
  at: number;
  kind: string;
  text: string;
  url: string;
  source?: string;
  resource?: string;
  status?: number;
}
export const devBrowserApi = {
  open: (signal?: AbortSignal) => call<{ id: string }>("/sessions", { mode: "dev" }, "POST", signal),
  log: (id: string, signal?: AbortSignal) => call<{ url: string; title: string; entries: DevLogEntry[] }>(`/sessions/${id}/devlog`, undefined, "GET", signal),
  close: (id: string, signal?: AbortSignal) => call<{ ok: boolean }>(`/sessions/${id}`, undefined, "DELETE", signal),
};

export interface AmazonResult {
  asin: string;
  title: string;
  price: string | null;
  rating: string | null;
  reviews: string | null;
  sponsored: boolean;
  prime: boolean;
  image: string | null;
}

/**
 * Gives control back to Neon after the shopper resumed a pending step: POST /sessions/:id/release on the
 * browser service (shopper control off, desktop mode). Never throws; logs and returns false on failure.
 */
export async function releaseShopperControl(sessionId: string): Promise<boolean> {
  if (!browserConfigured()) return false;
  try {
    await call(`/sessions/${encodeURIComponent(sessionId)}/release`, undefined, "POST", undefined, 8_000);
    return true;
  } catch (e) {
    console.error("[browser] release failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Closes the chat's live browser (chat deleted). Never throws. */
export async function closeChatBrowser(chatId: string): Promise<void> {
  const row = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { browserSessionId: true } }).catch(() => null);
  const id = byChat.get(chatId)?.id ?? row?.browserSessionId;
  byChat.delete(chatId);
  if (!id || !browserConfigured()) return;
  await call(`/sessions/${encodeURIComponent(id)}`, undefined, "DELETE", undefined, 8_000).catch(() => {});
}
