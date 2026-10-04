import { config } from "@/lib/config";
import AssistantChat from "@/components/store/AssistantChat";

export const dynamic = "force-dynamic";
export const metadata = {
  title: `${config.storeName} — Order anything from China, shipped to Canada`,
  description:
    "Canadian B2B sourcing: describe what you're building and our assistant finds every part from Chinese factories, fills your cart, and shows shipping before you pay.",
};

// The homepage is the assistant, full screen, like a chat app.
export default function Home() {
  return (
    <section className="chat-home">
      <AssistantChat />
    </section>
  );
}
