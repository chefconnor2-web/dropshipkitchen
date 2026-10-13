// The shopper's saved traveller details (My details in the chat): read, edit, delete. lib/traveller.ts.

import { NextResponse } from "next/server";
import { currentProfileOwner, deleteProfile, getProfile, saveProfile, testTravellerDetails } from "@/lib/traveller";
import { stripeKeyProblem } from "@/lib/config";
import { getShipTo, setShipTo } from "@/lib/cart";
import type { TravellerProfileData } from "@/lib/traveller";

/** Saved an address: the store's shipping (prices, delivery, Amazon's site and Deliver to) follows it. */
async function followAddress(p: TravellerProfileData | null) {
  if (!p?.country) return;
  const now = await getShipTo();
  await setShipTo({ country: p.country, zip: (p.postalCode ?? "").slice(0, 12), tier: now.tier });
}

// Test details are offered only while payments are in Stripe test mode.
const testMode = () => !stripeKeyProblem();

export const dynamic = "force-dynamic";
const noStore = { headers: { "cache-control": "no-store" } };

export async function GET() {
  return NextResponse.json({ profile: (await getProfile(await currentProfileOwner())) ?? {}, testMode: testMode() }, noStore);
}

export async function PUT(req: Request) {
  const owner = await currentProfileOwner();
  if (!owner.customerId && !owner.visitorId) return NextResponse.json({ error: "Open the chat first, then save your details." }, { status: 400 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  // "Fill test details" (test mode only): mock details with the tester's email, replacing what's saved.
  if (body.useTestDetails === true) {
    if (!testMode()) return NextResponse.json({ error: "Test details are only available in test mode." }, { status: 403 });
    await deleteProfile(owner);
    const profile = await saveProfile(owner, { ...testTravellerDetails(process.env.TEST_TRAVELLER_EMAIL?.trim() || "chefconnor2@gmail.com") });
    await followAddress(profile);
    return NextResponse.json({ profile }, noStore);
  }
  const profile = await saveProfile(owner, body);
  await followAddress(profile);
  return NextResponse.json({ profile }, noStore);
}

export async function DELETE() {
  await deleteProfile(await currentProfileOwner());
  return NextResponse.json({ ok: true }, noStore);
}
