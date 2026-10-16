import { prisma } from "@/lib/db";
import { neonKeyOk, ownerWho } from "@/lib/neon-browser";
import { waitNeon } from "@/lib/mcp-server";
import { getRun } from "@/lib/runs";

// Neon Browser → Chit: wait for a run's next state (done / waiting / still working). Key-guarded, owner-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!neonKeyOk(req.headers.get("x-neon-key"))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const who = await ownerWho();
  if (!who) return Response.json({ error: "No owner account is configured on Chit." }, { status: 500 });

  let body: { runId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Send JSON with a runId." }, { status: 400 });
  }
  const runId = String(body.runId ?? "").trim();
  if (!runId) return Response.json({ error: "runId is required." }, { status: 400 });

  const r = await getRun(runId);
  const c = r ? await prisma.assistantChat.findUnique({ where: { id: r.chatId }, select: { customerId: true } }) : null;
  if (!r || c?.customerId !== who.customerId) return Response.json({ error: "Unknown run." }, { status: 404 });

  return Response.json(await waitNeon(runId));
}
