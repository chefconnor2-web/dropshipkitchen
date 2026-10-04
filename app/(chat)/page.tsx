import { config } from "@/lib/config";

export const metadata = {
  title: `${config.storeName} — Order anything from China, shipped to Canada`,
  description:
    "Canadian B2B sourcing: describe what you're building or send a photo, and our assistant finds every part from Chinese factories, fills your cart, and shows shipping before you pay.",
};

// The chat itself is rendered by the layout, so it survives switching between chats.
export default function Home() {
  return null;
}
