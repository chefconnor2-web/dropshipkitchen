import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { config, storeInitials } from "@/lib/config";
import { cartCount } from "@/lib/cart";
import { assistantConfigured } from "@/lib/assistant";
import { listChats } from "@/lib/chat-session";
import ChatApp from "@/components/chat/ChatApp";

export const dynamic = "force-dynamic";

// The homepage and /c/<id> are one full-screen chat app (no store header or footer), laid out like ChatGPT.
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const [count, chats] = await Promise.all([cartCount(), listChats()]);
  return (
    <div className="store chat-app">
      <ChatApp storeName={config.storeName} initials={storeInitials()} configured={assistantConfigured()} cartCount={count} chats={chats} />
      {children}
    </div>
  );
}
