import { config } from "@/lib/config";
import { findOwnChat, getVisitorId } from "@/lib/chat-session";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const chat = await findOwnChat((await params).id, await getVisitorId());
  return { title: `${chat?.title ?? "Chat"} · ${config.storeName}`, robots: { index: false } };
}

// Rendered by the (chat) layout; this page only gives the chat its own address.
export default function ChatPage() {
  return null;
}
