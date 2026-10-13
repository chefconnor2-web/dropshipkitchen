// Client for the Chit browser service (browser-service/, its own Railway service): one live Chrome per chat
// that Neon drives and the shopper can watch and take over in the chat.
//
// BROWSER_SERVICE_URL     where the server reaches it (private network, e.g. http://chit-browser.railway.internal:8080)
// BROWSER_PUBLIC_URL      its public https address, for the live view in the shopper's browser
// BROWSER_SERVICE_SECRET  shared secret, set on both services

import { processSingleton } from "@/lib/singleton";

export function browserConfigured(): boolean {
  return !!(process.env.BROWSER_SERVICE_SECRET?.trim() && (process.env.BROWSER_SERVICE_URL?.trim() || process.env.BROWSER_PUBLIC_URL?.trim()));
}

const serviceUrl = () => (process.env.BROWSER_SERVICE_URL?.trim() || process.env.BROWSER_PUBLIC_URL?.trim() || "").replace(/\/$/, "");

export class BrowserError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const r = await fetch(serviceUrl() + path, {
    method,
    headers: { "content-type": "application/json", "x-browser-secret": process.env.BROWSER_SERVICE_SECRET?.trim() ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
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
  /** JPEG, base64, 390×780. */
  screenshot: string | null;
  [k: string]: unknown;
}

interface Session {
  id: string;
  viewToken: string;
}

// One browser per chat while the server runs (the service closes idle ones on its own).
const byChat = processSingleton("browser-sessions", () => new Map<string, Session>());

/** The live-view address for the shopper's browser. */
export function liveUrl(s: Session): string {
  const pub = (process.env.BROWSER_PUBLIC_URL?.trim() || serviceUrl()).replace(/^http/, "ws").replace(/\/$/, "");
  return `${pub}/live?id=${s.id}&token=${s.viewToken}`;
}

export async function chatBrowser(chatId: string): Promise<{ session: Session; created: boolean }> {
  const have = byChat.get(chatId);
  if (have) return { session: have, created: false };
  const session = await call<Session>("/sessions");
  byChat.set(chatId, session);
  return { session, created: true };
}

/** Runs a browser step for this chat, opening a new browser if the old one closed. */
export async function inBrowser<T>(chatId: string, step: (id: string) => Promise<T>): Promise<{ result: T; session: Session; created: boolean }> {
  let { session, created } = await chatBrowser(chatId);
  try {
    return { result: await step(session.id), session, created };
  } catch (e) {
    if (!(e instanceof BrowserError) || e.status !== 404) throw e;
    byChat.delete(chatId);
    ({ session, created } = await chatBrowser(chatId));
    return { result: await step(session.id), session, created };
  }
}

export const browserApi = {
  act: (id: string, actions: unknown[]) => call<PageState>(`/sessions/${id}/act`, { actions }),
  search: (id: string, domain: string, query: string) => call<PageState & { results?: AmazonResult[] }>(`/sessions/${id}/amazon/search`, { domain, query }),
  add: (id: string, domain: string, asin: string, quantity: number) =>
    call<PageState & { added?: boolean; title?: string; price?: string | null; quantity?: number; requestedQuantity?: number; reason?: string }>(`/sessions/${id}/amazon/add`, { domain, asin, quantity }),
  cart: (id: string, domain: string) => call<PageState & { items?: Array<{ asin: string; title: string; quantity: number | null; price: string | null }>; subtotal?: string | null }>(`/sessions/${id}/amazon/cart`, { domain }),
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
