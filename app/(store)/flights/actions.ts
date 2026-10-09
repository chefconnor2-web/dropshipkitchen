"use server";

import { redirect } from "next/navigation";
import { startFlightCheckout } from "@/lib/flight-booking";
import { getMemberId } from "@/lib/session";

export interface BookState {
  error?: string;
  /** The price the shopper has now seen (raised when the fare changed). */
  shownCents: number;
  /** What they typed, so a mistake doesn't wipe the form. */
  values?: Record<string, string>;
  n: number;
}

/** Booking page: passengers → Stripe Checkout. */
export async function bookFlightAction(prev: BookState, form: FormData): Promise<BookState> {
  const offerId = String(form.get("offerId") ?? "");
  const values = Object.fromEntries([...form.entries()].filter(([k, v]) => typeof v === "string" && !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
  let url: string | undefined;
  try {
    const r = await startFlightCheckout({ offerId, shownCents: prev.shownCents, form, customerId: await getMemberId() });
    if (r.url) url = r.url;
    else return { error: r.error, shownCents: r.newPriceCents ?? prev.shownCents, values, n: prev.n + 1 };
  } catch (e) {
    console.error("[flights] checkout failed:", e);
    return { error: "Something went wrong starting the payment. Please try again.", shownCents: prev.shownCents, values, n: prev.n + 1 };
  }
  redirect(url);
}

export interface FlightCancelState {
  error?: string;
  quote?: { quoteId: string; refundCents: number; creditOnly: boolean; expiresAt: string };
  done?: boolean;
  refundCents?: number;
}

/** Trip page: step 1 asks the airline what it refunds, step 2 cancels. The trip link token proves it's theirs. */
export async function flightCancelAction(prev: FlightCancelState, form: FormData): Promise<FlightCancelState> {
  const { prisma } = await import("@/lib/db");
  const { confirmFlightCancel, quoteFlightCancel, tripToken } = await import("@/lib/flight-booking");
  const b = await prisma.flightBooking.findUnique({ where: { number: String(form.get("number") ?? "") } });
  if (!b || String(form.get("t") ?? "") !== (await tripToken(b.id))) return { error: "We couldn't find this booking. Open it from your confirmation email." };
  try {
    const quoteId = String(form.get("quoteId") ?? "");
    if (!quoteId) {
      const q = await quoteFlightCancel(b.id);
      return "error" in q ? { error: q.error } : { quote: q };
    }
    const r = await confirmFlightCancel(b.id, quoteId);
    return "error" in r ? { error: r.error } : { done: true, refundCents: r.refundCents };
  } catch (e) {
    console.error("[flights] cancel failed:", e);
    return { ...prev, error: "Something went wrong. Please try again, or reply to your confirmation email." };
  }
}
