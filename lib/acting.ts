// Acting for a customer outside their browser: the Chit MCP (Claude, ChatGPT) calls Neon and the cart for a
// customer it signed in with OAuth, with no cookies. Inside acting.run(...), getMemberId() is that customer,
// the cart is their account's cart, and there is no anonymous visitor. It follows async work started inside
// (a Neon run keeps it after the MCP request has answered).

import { AsyncLocalStorage } from "node:async_hooks";

export interface Acting {
  customerId: string;
  /** Where to ship the cart, when the MCP caller says (else the customer's saved address). */
  shipTo?: { country: string; zip: string; tier: "standard" | "express" };
}

export const acting = new AsyncLocalStorage<Acting>();

export const actingAs = (): Acting | undefined => acting.getStore();
