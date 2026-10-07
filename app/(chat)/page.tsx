import { config } from "@/lib/config";

export const metadata = {
  title: `${config.storeName} — ${config.storeTagline}`,
  description:
    "Buy anything by texting: tell it what you need or send a photo, and it finds the products or flights, prices them with shipping, and checks you out right in the chat.",
};

// The chat itself is rendered by the layout, so it survives switching between chats.
export default function Home() {
  return null;
}
