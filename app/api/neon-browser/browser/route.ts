import { prisma } from "@/lib/db";
import { neonKeyOk, ownerWho } from "@/lib/neon-browser";
import { browserConfigured, mintLiveUrl } from "@/lib/browser";

// Neon Browser → Chit: a short-lived live-view address for the owner's current browser session. Key-guarded.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!neonKeyOk(req.headers.get("x-neon-key"))) return Response.json({ error: "Not allowed." }, { status: 401 });
  if (!browserConfigured()) return Response.json({ error: "The live browser isn't switched on." }, { status: 503 });
  const who = await ownerWho();
  if (!who) return Response.json({ error: "No owner account is configured on Chit." }, { status: 500 });

  let body: { chatId?: unknown; session?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Send JSON with chatId and session." }, { status: 400 });
  }
  const chatId = String(body.chatId ?? "");
  const session = String(body.session ?? "");
  if (!chatId || !session) return Response.json({ error: "chatId and session are required." }, { status: 400 });

  const chat = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { customerId: true, browserSessionId: true } });
  if (!chat || chat.customerId !== who.customerId || chat.browserSessionId !== session) return Response.json({ error: "This browser has closed." }, { status: 404 });

  return Response.json(mintLiveUrl(session), { headers: { "cache-control": "no-store" } });
}
