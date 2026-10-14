// Shared pieces of the Chit MCP's tools: who they act for, results (text for the model, cards for the in-chat
// view), and the guard every tool runs through (rate limit, audit row, errors as tool errors).

import { prisma } from "@/lib/db";
import type { ViewCard } from "@/lib/mcp-cards";
import { VIEW_URI } from "@/lib/mcp-view";

/** Tool calls per customer: per minute and per hour. */
export const PER_MINUTE = 40;
export const PER_HOUR = 300;

export interface Who {
  customerId: string;
  clientId: string;
  clientName: string;
  /** Connected with read-only access: tools that buy, book, cancel or change anything refuse. */
  readOnly?: boolean;
}

/** Tools that change something (buy, book, cancel, edit): refused on read-only connections. */
export const WRITE_TOOLS = new Set([
  "find_rental_car", "set_work_trip", "log_expense", "add_to_cart", "update_cart", "ask_neon", "approve_neon_step", "browser_done",
  "book_flight", "book_hotel", "hold_flight", "pay_held_flight", "checkout_cart", "cancel_flight", "cancel_hotel", "share_trip",
  "update_my_details", "subscribe", "invite_member", "edit_policy", "cart_change", "pay_with_saved_card",
]);

/** Per customer per day, across all their apps: a brake on runaway agents. */
export const DAILY_CAPS: Record<string, number> = { book_flight: 20, book_hotel: 20, hold_flight: 10, checkout_cart: 20, cancel_flight: 5, cancel_hotel: 5, pay_with_saved_card: 10, invite_member: 30, ask_neon: 60 };

export interface Out {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const txt = (o: unknown, isError = false): Out => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o) }], ...(isError ? { isError: true } : {}) });

/**
 * A result with cards for the in-chat view. Some clients give the model only structuredContent when it's present,
 * so it also carries the model's answer (`result`); the view ignores it.
 */
export const withCards = (o: unknown, cards: ViewCard[], view: { title?: string; footer?: string } = {}): Out => ({ ...txt(o), structuredContent: { result: o, cards, ...view } });

/** Tools whose results the in-chat view draws (MCP Apps; the second key is the older spelling hosts still read). */
export const UI = { ui: { resourceUri: VIEW_URI }, "ui/resourceUri": VIEW_URI, "openai/outputTemplate": VIEW_URI };

async function rateLimited(customerId: string): Promise<boolean> {
  const [minute, hour] = await Promise.all([
    prisma.mcpCall.count({ where: { customerId, createdAt: { gt: new Date(Date.now() - 60_000) } } }),
    prisma.mcpCall.count({ where: { customerId, createdAt: { gt: new Date(Date.now() - 3600_000) } } }),
  ]);
  return minute >= PER_MINUTE || hour >= PER_HOUR;
}

/** Wraps a tool: rate limit, audit row, and errors as tool errors (never a thrown protocol error). */
export function guarded<A>(who: Who, name: string, fn: (a: A) => Promise<Out>) {
  return async (a: A): Promise<Out> => {
    if (who.readOnly && WRITE_TOOLS.has(name)) return txt("This connection is read-only. To buy, book or change things, the customer reconnects Chit with full access (Connect page in Chit).", true);
    if (await rateLimited(who.customerId)) return txt("Too many requests for this account right now. Wait a minute and try again.", true);
    const cap = DAILY_CAPS[name];
    if (cap && (await prisma.mcpCall.count({ where: { customerId: who.customerId, tool: name, ok: true, createdAt: { gt: new Date(Date.now() - 86_400_000) } } })) >= cap)
      return txt(`That's the daily limit for ${name} through connected apps (${cap}). It resets over the next day; the customer can still do it in Chit.`, true);
    const t0 = Date.now();
    let out: Out;
    try {
      out = await fn(a);
    } catch (e) {
      console.error(`[mcp] ${name} failed:`, e instanceof Error ? e.message : e);
      out = txt(`${name} failed: ${e instanceof Error ? e.message : "an error"}. Try again.`, true);
    }
    await prisma.mcpCall.create({ data: { customerId: who.customerId, clientId: who.clientId, tool: name, ok: !("isError" in out), ms: Date.now() - t0 } }).catch(() => {});
    return out;
  };
}
