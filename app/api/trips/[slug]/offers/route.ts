// GET ?adults=2&children=5,9: today's offers for friends joining a shared trip (the same flights, or the
// closest that day). Run from the browser only, never on page render, so link-preview bots don't search; a
// few searches per visitor at most, since every search counts against Duffel's search-to-book allowance.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { processSingleton } from "@/lib/singleton";
import { departed, joinOffers } from "@/lib/shared-trips";
import type { FlightCard } from "@/lib/flights-shared";

const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 12;
const hits = processSingleton("trip-offer-hits", () => new Map<string, number[]>());

function allow(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) return false;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value!);
  return true;
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trip = await prisma.sharedTrip.findUnique({ where: { slug: (await params).slug } });
  if (!trip) return NextResponse.json({ error: "This trip link doesn't exist." }, { status: 404 });
  if (departed(JSON.parse(trip.cardJson) as FlightCard)) return NextResponse.json({ error: "This trip has already left." }, { status: 410 });
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
  if (!allow(ip)) return NextResponse.json({ error: "Too many searches. Wait a few minutes and try again." }, { status: 429 });

  const q = new URL(req.url).searchParams;
  const adults = Math.min(9, Math.max(1, Math.round(Number(q.get("adults")) || 1)));
  const childAges = (q.get("children") || "")
    .split(",")
    .filter(Boolean)
    .map((a) => Math.round(Number(a)))
    .filter((a) => a >= 0 && a < 18)
    .slice(0, 8);
  try {
    return NextResponse.json(await joinOffers(trip, adults, childAges));
  } catch (e) {
    console.error("[trips] search failed:", e);
    return NextResponse.json({ error: "Couldn't reach the airlines just now. Try again in a minute." }, { status: 502 });
  }
}
