import { NextResponse } from "next/server";
import { currentOwner } from "@/lib/chat-session";
import { tripsFor } from "@/lib/trips";

export const dynamic = "force-dynamic";

/** The current shopper's trips (their chats with bookings): itinerary, receipts and confirmations. */
export async function GET() {
  const { customerId, visitorId, where } = await currentOwner();
  if (!customerId && !visitorId) return NextResponse.json({ trips: [] });
  return NextResponse.json({ trips: await tripsFor({ customerId, where }) }, { headers: { "cache-control": "no-store" } });
}
