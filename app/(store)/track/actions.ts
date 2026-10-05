"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { clientIp, normalizeEmail, orderViewToken } from "@/lib/session";
import { processSingleton } from "@/lib/singleton";

/** Lookups per network address per window, so order numbers can't be guessed by brute force. */
const MAX_TRIES = 10;
const WINDOW_MS = 15 * 60_000;
const tries = processSingleton("track-lookups", () => new Map<string, number[]>());

function limited(key: string): boolean {
  const now = Date.now();
  const recent = (tries.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  tries.set(key, recent);
  if (tries.size > 5000) for (const [k, v] of tries) if (!v.some((t) => now - t < WINDOW_MS)) tries.delete(k);
  return recent.length > MAX_TRIES;
}

export type TrackState = { error?: string; number?: string; email?: string };

/** Order number + the email it was placed with → that order's page. One answer for every miss, so it reveals nothing. */
export async function trackLookupAction(_prev: TrackState, form: FormData): Promise<TrackState> {
  const number = String(form.get("number") ?? "").trim().toUpperCase().replace(/\s+/g, "").replace(/^#/, "").slice(0, 40);
  const email = normalizeEmail(form.get("email"));
  const back = { number, email: String(form.get("email") ?? "").slice(0, 254) };
  if (!number || !email) return { ...back, error: "Enter your order number and the email you ordered with." };
  if (limited(`ip:${(await clientIp()) ?? "?"}`) || limited(`n:${number}`)) return { ...back, error: "Too many tries. Please wait a few minutes and try again." };
  const order = await prisma.order.findUnique({ where: { number }, select: { id: true, number: true, email: true, status: true } });
  if (!order || order.status === "PENDING_PAYMENT" || (order.email ?? "").trim().toLowerCase() !== email)
    return { ...back, error: "We couldn’t find an order with that number and email. Check your confirmation email for both." };
  redirect(`/orders/${encodeURIComponent(order.number)}?t=${await orderViewToken(order.id)}`);
}
