"use server";

import { redirect } from "next/navigation";
import { startHotelCheckout } from "@/lib/hotel-booking";
import { getMemberId } from "@/lib/session";

export interface HotelBookState {
  error?: string;
  /** The price the shopper has now seen (raised when the hotel changed it). */
  shownCents: number;
  values?: Record<string, string>;
  n: number;
}

/** Booking page: lead guest → hold the room → Stripe Checkout. */
export async function bookHotelAction(prev: HotelBookState, form: FormData): Promise<HotelBookState> {
  const offerId = String(form.get("offerId") ?? "");
  const values = Object.fromEntries([...form.entries()].filter(([k, v]) => typeof v === "string" && !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
  let url: string | undefined;
  try {
    const r = await startHotelCheckout({ offerId, shownCents: prev.shownCents, form, customerId: await getMemberId() });
    if (r.url) url = r.url;
    else return { error: r.error, shownCents: r.newPriceCents ?? prev.shownCents, values, n: prev.n + 1 };
  } catch (e) {
    console.error("[hotels] checkout failed:", e);
    return { error: "Something went wrong starting the payment. Please try again.", shownCents: prev.shownCents, values, n: prev.n + 1 };
  }
  redirect(url);
}
