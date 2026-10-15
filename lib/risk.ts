// The check before we pay an airline or hotel for a booking the shopper just paid for. Chit refuses customers who
// disputed a payment before (their account, email or card), and holds a booking for the owner's OK when the payment
// looks like it could be a stolen card: no 3-D Secure (so a fraud chargeback would be our loss) and the cardholder's
// name matches none of the travellers, or Stripe's own risk check rates it high. Everything else books at once.

import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { stripe } from "@/lib/stripe";

export interface PaymentFacts {
  /** The payment passed 3-D Secure: a fraud chargeback is the bank's loss, not ours. */
  threeDs: boolean;
  /** Stripe Radar: normal | elevated | highest (null when unknown, e.g. pay-later methods). */
  riskLevel: string | null;
  cardholder: string | null;
  fingerprint: string | null;
  /** Paid with a card (pay-later providers carry their own fraud risk). */
  card: boolean;
}

export type RiskAction = { action: "book" } | { action: "hold"; reason: string } | { action: "refuse"; reason: string };

const words = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1);

/** Whether the cardholder's name shares a surname-sized word with any traveller's name. */
export function nameMatches(cardholder: string | null, travellers: string[]): boolean {
  if (!cardholder) return true; // no name to compare: don't hold on that alone
  const card = new Set(words(cardholder));
  return travellers.some((t) => words(t).some((w) => card.has(w)));
}

/** The decision, from what Stripe says about the payment and who's travelling. */
export function riskDecision(p: PaymentFacts, travellers: string[], blocked: boolean): RiskAction {
  if (blocked) return { action: "refuse", reason: "This customer, email or card disputed an earlier payment." };
  if (!p.card) return { action: "book" };
  if (p.riskLevel === "highest") return { action: "hold", reason: "Stripe rates this payment highest risk." };
  if (p.threeDs) return { action: "book" };
  if (p.riskLevel === "elevated") return { action: "hold", reason: "Stripe rates this payment elevated risk and it didn't pass 3-D Secure." };
  if (!nameMatches(p.cardholder, travellers)) return { action: "hold", reason: `No 3-D Secure, and the cardholder (${p.cardholder}) isn't one of the travellers.` };
  return { action: "book" };
}

/** What Stripe knows about a payment intent's charge. */
export async function paymentFacts(paymentIntent: string): Promise<PaymentFacts> {
  const pi = await stripe().paymentIntents.retrieve(paymentIntent, { expand: ["latest_charge"] });
  const ch = typeof pi.latest_charge === "object" ? (pi.latest_charge as Stripe.Charge | null) : null;
  const card = ch?.payment_method_details?.card;
  return {
    threeDs: card?.three_d_secure?.result === "authenticated" || card?.three_d_secure?.result === "attempt_acknowledged",
    riskLevel: ch?.outcome?.risk_level ?? null,
    cardholder: ch?.billing_details?.name ?? null,
    fingerprint: card?.fingerprint ?? null,
    card: !!card,
  };
}

/** Whether this customer, email or card has disputed a payment with us (any dispute we didn't win). */
export async function isBlocked(who: { customerId?: string | null; email?: string | null; fingerprint?: string | null }): Promise<boolean> {
  const or = [
    ...(who.customerId ? [{ customerId: who.customerId }] : []),
    ...(who.email ? [{ email: who.email.toLowerCase() }] : []),
    ...(who.fingerprint ? [{ cardFingerprint: who.fingerprint }] : []),
  ];
  if (!or.length) return false;
  return !!(await prisma.dispute.findFirst({ where: { OR: or, status: { not: "won" } }, select: { id: true } }));
}

export const BLOCKED_MESSAGE = "We can't take new bookings on this account. Please contact us.";

/** The full check for a paid booking. A failure to reach Stripe holds the booking rather than risk it. */
export async function checkPaidBooking(paymentIntent: string | null, travellers: string[], who: { customerId?: string | null; email?: string | null }): Promise<RiskAction & { facts?: PaymentFacts }> {
  if (!paymentIntent) return { action: "book" };
  let facts: PaymentFacts;
  try {
    facts = await paymentFacts(paymentIntent);
  } catch (e) {
    return { action: "hold", reason: `Couldn't check the payment with Stripe (${e instanceof Error ? e.message : e}).` };
  }
  const blocked = await isBlocked({ ...who, fingerprint: facts.fingerprint });
  return { ...riskDecision(facts, travellers, blocked), facts };
}

/** Error text marking a paid booking held for the owner's OK (status NEEDS_REVIEW). */
export const RISK_HOLD = "Held for your approval: ";

/** Whether a payment has a dispute the bank is still deciding (or we lost). */
export async function openDispute(paymentIntent: string | null | undefined): Promise<boolean> {
  if (!paymentIntent) return false;
  return !!(await prisma.dispute.findFirst({ where: { paymentIntent, status: { notIn: ["won", "warning_closed"] } }, select: { id: true } }));
}
