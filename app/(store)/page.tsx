import Link from "next/link";
import { config } from "@/lib/config";
import AssistantChat from "@/components/store/AssistantChat";

export const dynamic = "force-dynamic";
export const metadata = {
  title: `${config.storeName} — Order anything from China, shipped to Canada`,
  description:
    "Canadian B2B sourcing: describe what you're building and our assistant finds every part from Chinese factories, fills your cart, and shows shipping before you pay.",
};

// The homepage is the assistant: a short headline, then the chat filling the screen.
export default function Home() {
  return (
    <section className="chat-home">
      <div className="wrap chat-home-inner">
        <div className="chat-home-head">
          <h1>Order anything from China.</h1>
          <p>
            Tell the assistant what you’re building. It finds every part, fills your cart and shows shipping to Canada.{" "}
            <Link href="/boxes">Mystery boxes</Link> · <Link href="/search">Search</Link>
          </p>
        </div>
        <AssistantChat />
      </div>
    </section>
  );
}
