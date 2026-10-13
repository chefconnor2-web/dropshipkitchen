// POST /api/google/disconnect: forgets the shopper's Gmail (Neon can no longer send from it).
import { disconnectGmail } from "@/lib/gmail";
import { getVisitorId } from "@/lib/chat-session";
import { getMemberId } from "@/lib/session";
import { crossOrigin } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (crossOrigin(req)) return Response.json({ error: "Not allowed." }, { status: 403 });
  await disconnectGmail({ customerId: await getMemberId(), visitorId: await getVisitorId() });
  return Response.json({ ok: true });
}
