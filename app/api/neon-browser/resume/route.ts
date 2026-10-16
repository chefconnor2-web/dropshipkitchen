import { prisma } from "@/lib/db";
import { neonKeyOk, ownerWho } from "@/lib/neon-browser";
import { getRun, resumeRun } from "@/lib/runs";

// Neon Browser → Chit: the owner finished a step Neon was waiting on; resume exactly that step. Key-guarded.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!neonKeyOk(req.headers.get("x-neon-key"))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const who = await ownerWho();
  if (!who) return Response.json({ error: "No owner account is configured on Chit." }, { status: 500 });

  let body: { runId?: unknown; stepId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Send JSON with runId and stepId." }, { status: 400 });
  }
  const runId = String(body.runId ?? "");
  const stepId = String(body.stepId ?? "");
  if (!/^st_[A-Za-z0-9_-]{1,40}$/.test(stepId)) return Response.json({ accepted: false, error: "That isn't a step Neon asked for." }, { status: 409 });

  const got = await getRun(runId);
  const c = got ? await prisma.assistantChat.findUnique({ where: { id: got.chatId }, select: { customerId: true } }) : null;
  if (!got || c?.customerId !== who.customerId) return Response.json({ error: "Not found." }, { status: 404 });

  const r = await resumeRun(runId, stepId);
  return Response.json(r.body, { status: r.status });
}
