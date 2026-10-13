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
  signIn: boolean;
  /** Set when only the shopper can get past the page (robot check, sign in): what to tell them. */
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

/** A short-lived live-view address for this session (HMAC token, CONTRACTS.md §3). Server only. */
export function mintLiveUrl(sessionId: string, ttlSeconds = 600): { url: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = createHmac("sha256", secret()).update(`live.${sessionId}.${exp}`).digest("base64url");
  const pub = (process.env.BROWSER_PUBLIC_URL?.trim() || serviceUrl()).replace(/^http/, "ws").replace(/\/$/, "");
  return { url: `${pub}/live?id=${encodeURIComponent(sessionId)}&exp=${exp}&token=${token}`, expiresAt: new Date(exp * 1000).toISOString() };
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
  const created = await call<{ id: string }>("/sessions", undefined, "POST", signal);
  const session = { id: created.id };
  await remember(chatId, session);
  return { session, created: true };
}

/** Runs a browser step for this chat, opening a new browser if the old one closed. */
export async function inBrowser<T>(chatId: string, step: (id: string) => Promise<T>, signal?: AbortSignal): Promise<{ result: T; session: Session; created: boolean }> {
  let { session, created } = await chatBrowser(chatId, signal);
  try {
    return { result: await step(session.id), session, created };
  } catch (e) {
    if (!(e instanceof BrowserError) || e.status !== 404) throw e;
    byChat.delete(chatId);
    await prisma.assistantChat.update({ where: { id: chatId }, data: { browserSessionId: null } }).catch(() => {});
    ({ session, created } = await chatBrowser(chatId, signal));
    return { result: await step(session.id), session, created };
  }
}

export const browserApi = {
  act: (id: string, actions: unknown[], signal?: AbortSignal) => call<PageState>(`/sessions/${id}/act`, { actions }, "POST", signal),
  state: (id: string, signal?: AbortSignal) => call<PageState>(`/sessions/${id}/state`, undefined, "GET", signal),
  search: (id: string, domain: string, query: string, signal?: AbortSignal) =>
    call<PageState & { results?: AmazonResult[] }>(`/sessions/${id}/amazon/search`, { domain, query }, "POST", signal),
  add: (id: string, domain: string, asin: string, quantity: number, signal?: AbortSignal) =>
    call<PageState & { added?: boolean; title?: string; price?: string | null; quantity?: number; requestedQuantity?: number; reason?: string }>(
      `/sessions/${id}/amazon/add`,
      { domain, asin, quantity },
      "POST",
      signal,
    ),
  cart: (id: string, domain: string, signal?: AbortSignal) =>
    call<PageState & { items?: Array<{ asin: string; title: string; quantity: number | null; price: string | null }>; subtotal?: string | null }>(
      `/sessions/${id}/amazon/cart`,
      { domain },
      "POST",
      signal,
    ),
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
