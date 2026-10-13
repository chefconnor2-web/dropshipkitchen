// POST /api/assistant/runs/:id/cancel: stop a run (Stop button). Waits briefly for the stopped reply to be saved.
import { findOwnChat } from "@/lib/chat-session";
import { cancelRun, crossOrigin, getRun } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (crossOrigin(req)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const id = (await params).id;
  const got = await getRun(id);
  if (!got || !(await findOwnChat(got.chatId))) return Response.json({ error: "Not found" }, { status: 404 });
  const r = await cancelRun(id);
  if (!r) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(r);
}
