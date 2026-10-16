import { prisma } from "@/lib/db";
import { neonKeyOk, ownerWho } from "@/lib/neon-browser";
import { askNeon } from "@/lib/mcp-server";

// Neon Browser → Chit: start (or continue) a Neon turn for the owner's account. Key-guarded, owner-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!neonKeyOk(req.headers.get("x-neon-key"))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const who = await ownerWho();
  if (!who) return Response.json({ error: "No owner account is configured on Chit." }, { status: 500 });

  let body: { message?: unknown; chatId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Send JSON with a message." }, { status: 400 });
  }
  const message = String(body.message ?? "").trim();
  if (!message || message.length > 4000) return Response.json({ error: "message must be 1 to 4000 characters." }, { status: 400 });
  const chatId = typeof body.chatId === "string" && body.chatId ? body.chatId : undefined;
  if (chatId) {
    const c = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { customerId: true } });
    if (!c || c.customerId !== who.customerId) return Response.json({ error: "Unknown chat." }, { status: 404 });
  }

  const r = await askNeon(who, message, chatId);
  return Response.json(r);
}
