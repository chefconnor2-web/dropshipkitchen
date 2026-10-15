// Refund terms in plain words, the same everywhere the shopper sees a flight or hotel price: the chat card, the
// booking page, Stripe Checkout (just above Pay), the confirmation email and /refunds. They say exactly what the
// code does: a booking we can't make is refunded in full automatically; a cancellation returns what the airline
// or hotel refunds, and our service fee is kept. Clear terms up front are what stop "I didn't know" disputes.

import { config } from "@/lib/config";
import { ruleLabel, type FlightCard, type HotelCard } from "@/lib/flights-shared";

export const refundPolicyUrl = () => `${config.siteUrl}/refunds`;

/** The fare's refund and change rules in one line ("Refundable · Changes USD 75"), or how to read unknown ones. */
export function fareRulesLine(card: Pick<FlightCard, "refundRule" | "changeRule" | "refundable" | "changeable">): string {
  const refund = ruleLabel(card.refundRule, "refund") ?? (card.refundable === true ? "Refundable" : card.refundable === false ? "No refund" : "Refund rules not stated by the airline: treat it as non-refundable");
  const changes = ruleLabel(card.changeRule, "changes") ?? (card.changeable === true ? "Changes allowed (the airline may charge)" : card.changeable === false ? "No changes" : null);
  return [refund, changes].filter(Boolean).join(" · ");
}

/** The terms for a flight, a sentence or two. */
export function flightTerms(card: Pick<FlightCard, "refundRule" | "changeRule" | "refundable" | "changeable">): string {
  const r = card.refundRule?.kind;
  const cancel =
    r === "no" || (!card.refundRule && card.refundable !== true)
      ? "If you cancel, nothing is refunded."
      : "If you cancel, you get back what the airline refunds, shown before you confirm; our service fee isn't refunded.";
  return `${fareRulesLine(card)}. ${cancel} If we can't book it after you pay, you get everything back automatically.`;
}

/** The terms for a hotel stay, a sentence or two. */
export function hotelTerms(card: Pick<HotelCard, "refundable" | "freeCancelUntil">): string {
  const cancel =
    card.refundable === false
      ? "Non-refundable: nothing is refunded if you cancel."
      : card.refundable === true
        ? `Free cancellation${card.freeCancelUntil ? ` until ${card.freeCancelUntil}` : " (the deadline is in your confirmation)"}: cancel online for a refund of the room price; our service fee isn't refunded. After that, no refund.`
        : "Cancellation follows the hotel's policy in your confirmation; our service fee isn't refunded.";
  return `${cancel} If we can't book it after you pay, you get everything back automatically.`;
}

/** Stripe Checkout's note above Pay (Stripe allows up to 1,200 characters). */
export function checkoutNote(terms: string): string {
  return `${terms} Full refund policy: ${refundPolicyUrl()}`.slice(0, 1200);
}

/** The lines every booking email ends with: the terms, where to cancel, and how to reach a person. */
export function emailTerms(terms: string, manageUrl: string): string {
  const help = config.email.storeEmail ? `Questions or a problem? Reply to this email or write to ${config.email.storeEmail}; we answer within one business day.` : "Questions or a problem? Reply to this email; we answer within one business day.";
  return `Refunds: ${terms}\nCancel from your booking page: ${manageUrl}\nFull refund policy: ${refundPolicyUrl()}\n\n${help} Please contact us before disputing a charge: it's faster, and we'll make it right.`;
}
