// The shopper's chat history (their account's, or this browser's when signed out) for the sidebar, newest first.
import { ensureVisitorId, listChats } from "@/lib/chat-session";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureVisitorId();
  return Response.json({ chats: await listChats() });
}
