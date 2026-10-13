// GET /api/assistant/runs/:id → { run, done } for the run's owner (404 for anyone else).
import { findOwnChat } from "@/lib/chat-session";
import { getRun } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const got = await getRun((await params).id);
  if (!got || !(await findOwnChat(got.chatId))) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ run: got.run, done: got.done }, { headers: { "cache-control": "no-store" } });
}
