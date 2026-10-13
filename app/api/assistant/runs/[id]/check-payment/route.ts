// POST /api/assistant/runs/:id/check-payment: the shopper came back to the chat from paying in their own
// browser. Checks for the payment now instead of at the next poll; the run resumes by itself if it's there.
import { findOwnChat } from "@/lib/chat-session";
import { pokePayment } from "@/lib/payment-watch";
import { crossOrigin, getRun } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (crossOrigin(req)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const got = await getRun((await params).id);
  if (!got || !(await findOwnChat(got.chatId))) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ watching: pokePayment(got.chatId) });
}
