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
