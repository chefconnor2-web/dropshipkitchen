// POST {offerId}: a shareable trip link for flights found in the chat ("Share" on a flight card), so friends
// can book the same flights. The offer must still be live, so what's shared is real.

import { NextResponse } from "next/server";
import { DuffelError, duffelConfigured } from "@/lib/duffel";
import { shareFromOffer, sharedTripUrl } from "@/lib/shared-trips";

export async function POST(req: Request) {
  if (!duffelConfigured()) return NextResponse.json({ error: "Flights aren't available right now." }, { status: 503 });
  const { offerId } = (await req.json().catch(() => ({}))) as { offerId?: unknown };
  if (typeof offerId !== "string" || !/^off_[A-Za-z0-9]{1,80}$/.test(offerId)) return NextResponse.json({ error: "Not a flight we can share." }, { status: 400 });
  try {
    return NextResponse.json({ url: sharedTripUrl(await shareFromOffer(offerId)) });
  } catch (e) {
    const gone = e instanceof DuffelError && e.status === 404;
    return NextResponse.json({ error: gone ? "This fare has expired. Search again, then share." : "Couldn't reach the airline. Try again." }, { status: gone ? 410 : 502 });
  }
}
