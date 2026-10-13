// GET /api/assistant/browser?chat=<chatId>&session=<sessionId> → { url, expiresAt }: a live-view address with a
// token that expires in 10 minutes, only for the chat's owner and only for that chat's own browser.
import { findOwnChat } from "@/lib/chat-session";
import { browserConfigured, mintLiveUrl } from "@/lib/browser";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  if (!browserConfigured()) return Response.json({ error: "The live browser isn't switched on." }, { status: 503 });
  const chat = await findOwnChat(q.get("chat"));
  const session = q.get("session") ?? "";
  if (!chat || !session || chat.browserSessionId !== session) return Response.json({ error: "This browser has closed." }, { status: 404 });
  return Response.json(mintLiveUrl(session), { headers: { "cache-control": "no-store" } });
}
