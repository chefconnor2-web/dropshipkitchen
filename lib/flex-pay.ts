// Pay later at Stripe Checkout for flights and hotels: Klarna, Affirm and Afterpay next to cards. The shopper
// pays over time; we're paid in full up front and the provider carries the risk. These cost more than cards
// (about 6% + 30¢), so they're only offered when our margin on that booking covers it: we never lose money.
// FLEX_PAY=off turns them off; FLEX_PAY_COST_PCT (default 6.5) is the fee assumed.

import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";

// Where each method works (Stripe's supported currencies for the shopper's charge).
const METHODS: Array<[string, string[]]> = [
  ["klarna", ["usd", "cad", "eur", "gbp", "aud", "nzd", "dkk", "nok", "sek", "chf", "czk", "pln"]],
  ["affirm", ["usd", "cad"]],
  ["afterpay_clearpay", ["usd", "cad", "aud", "nzd", "gbp"]],
];
// Card processing and booking costs the margin must still cover after the pay-later fee (cents).
const RESERVE_CENTS = 5_00;

/** The payment methods to offer, or null for the account's defaults (cards) when pay later doesn't pay for itself. */
export function flexPayTypes(priceCents: number, costCents: number, currency: string): string[] | null {
  if ((process.env.FLEX_PAY ?? "").trim().toLowerCase() === "off") return null;
  const pct = Number(process.env.FLEX_PAY_COST_PCT);
  const feePct = Number.isFinite(pct) && pct > 0 ? pct : 6.5;
  const fee = Math.ceil((priceCents * feePct) / 100) + 30;
  if (priceCents - costCents < fee + RESERVE_CENTS) return null;
  const cur = currency.toLowerCase();
  const methods = METHODS.filter(([, cs]) => cs.includes(cur)).map(([m]) => m);
  return methods.length ? ["card", ...methods] : null;
}

/**
 * Creates the Checkout session with pay later when it fits. If Stripe refuses a method (not switched on in
 * the Dashboard, or not available for this amount or currency), it tries cards and Klarna, then cards only.
 */
export async function checkoutWithFlexPay(params: Stripe.Checkout.SessionCreateParams, types: string[] | null): Promise<Stripe.Checkout.Session> {
  const tries: Array<string[] | null> = types ? [types, types.filter((t) => t === "card" || t === "klarna"), null] : [null];
  let last: unknown;
  for (const t of tries) {
    try {
      return await stripe().checkout.sessions.create(t && t.length > 1 ? { ...params, payment_method_types: t as Stripe.Checkout.SessionCreateParams.PaymentMethodType[] } : params);
    } catch (e) {
      last = e;
      const invalid = (e as { type?: string })?.type === "StripeInvalidRequestError";
      if (!invalid || !t) throw e;
    }
  }
  throw last;
}
