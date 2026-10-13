// POST /api/assistant/runs/:id/resume {stepId}: the shopper finished the step Neon was waiting on.
// 200 { accepted: true, stepId } only for exactly the pending step; 409 { accepted: false, reason, current } otherwise.
import { findOwnChat } from "@/lib/chat-session";
import { crossOrigin, getRun, resumeRun } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (crossOrigin(req)) return Response.json({ error: "Not allowed." }, { status: 403 });
  const id = (await params).id;
  const got = await getRun(id);
  if (!got || !(await findOwnChat(got.chatId))) return Response.json({ error: "Not found" }, { status: 404 });
  const { stepId } = (await req.json().catch(() => ({}))) as { stepId?: unknown };
  if (typeof stepId !== "string" || !/^st_[A-Za-z0-9_-]{1,40}$/.test(stepId))
    return Response.json({ accepted: false, reason: "not_waiting", message: "That isn't a step Neon asked for.", current: got.run }, { status: 409 });
  const r = await resumeRun(id, stepId);
  return Response.json(r.body, { status: r.status });
}
