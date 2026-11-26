// The shopper's own Anthropic API key (My details → AI key): see whether one is saved, save one after checking
// it with Anthropic, or remove it. The key itself never leaves the server; only "…abcd" comes back. lib/ai-key.ts.

import { NextResponse } from "next/server";
import { currentProfileOwner } from "@/lib/traveller";
import { crossOrigin } from "@/lib/runs";
import { deleteOwnKey, ownKeyHint, plausibleKey, platformKey, saveOwnKey, testKey } from "@/lib/ai-key";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const noStore = { headers: { "cache-control": "no-store" } };

export async function GET() {
  const hint = await ownKeyHint(await currentProfileOwner());
  return NextResponse.json({ hasKey: !!hint, hint, storeKey: !!platformKey() }, noStore);
}

export async function PUT(req: Request) {
  if (crossOrigin(req)) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const owner = await currentProfileOwner();
  if (!owner.customerId && !owner.visitorId) return NextResponse.json({ error: "Open the chat first, then add your key." }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!plausibleKey(key)) return NextResponse.json({ error: "That doesn't look like an Anthropic API key. It starts with sk-ant-." }, { status: 400 });
  const problem = await testKey(key);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  const { hint } = await saveOwnKey(owner, key);
  return NextResponse.json({ hasKey: true, hint }, noStore);
}

export async function DELETE(req: Request) {
  if (crossOrigin(req)) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  await deleteOwnKey(await currentProfileOwner());
  return NextResponse.json({ hasKey: false, hint: null }, noStore);
}
