import { config } from "@/lib/config";

const title = `${config.storeName} — ${config.storeTagline}`;
const description =
  "Buy anything by texting: tell it what you need or send a photo, and it finds the products or flights, prices them with shipping, and checks you out right in the chat.";
const card = [{ url: "/share-card", width: 1200, height: 630, alt: config.storeName }];

export const metadata = {
  title,
  description,
  openGraph: { title, description, url: "/", siteName: config.storeName, type: "website", images: card },
  twitter: { card: "summary_large_image", title, description, images: ["/share-card"] },
};

// The chat itself is rendered by the layout, so it survives switching between chats.
export default function Home() {
  return null;
}
