// The visitor's chat history for the sidebar, newest first.
import { ensureVisitorId, listChats } from "@/lib/chat-session";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ chats: await listChats(await ensureVisitorId()) });
}
