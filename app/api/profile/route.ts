// The shopper's saved traveller details (My details in the chat): read, edit, delete. lib/traveller.ts.

import { NextResponse } from "next/server";
import { currentProfileOwner, deleteProfile, getProfile, saveProfile } from "@/lib/traveller";

export const dynamic = "force-dynamic";
const noStore = { headers: { "cache-control": "no-store" } };

export async function GET() {
  return NextResponse.json({ profile: (await getProfile(await currentProfileOwner())) ?? {} }, noStore);
}

export async function PUT(req: Request) {
  const owner = await currentProfileOwner();
  if (!owner.customerId && !owner.visitorId) return NextResponse.json({ error: "Open the chat first, then save your details." }, { status: 400 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  return NextResponse.json({ profile: await saveProfile(owner, body) }, noStore);
}

export async function DELETE() {
  await deleteProfile(await currentProfileOwner());
  return NextResponse.json({ ok: true }, noStore);
}
