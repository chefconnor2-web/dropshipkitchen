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

export interface CancelState {
  error?: string;
  done?: boolean;
  refundCents?: number;
}

/** Stay page: cancel under the hotel's policy. The page's own link token proves it's this guest's booking. */
export async function cancelStayAction(_prev: CancelState, form: FormData): Promise<CancelState> {
  const { prisma } = await import("@/lib/db");
  const { cancelStay, stayToken } = await import("@/lib/hotel-booking");
  const b = await prisma.hotelBooking.findUnique({ where: { number: String(form.get("number") ?? "") } });
  if (!b || String(form.get("t") ?? "") !== (await stayToken(b.id))) return { error: "We couldn't find this booking. Open it from your confirmation email." };
  try {
    const r = await cancelStay(b.id);
    return "error" in r ? { error: r.error } : { done: true, refundCents: r.refundCents };
  } catch (e) {
    console.error("[hotels] cancel failed:", e);
    return { error: "Something went wrong. Please try again, or reply to your confirmation email." };
  }
}
