import Link from "next/link";
import { config } from "@/lib/config";
import AssistantChat from "@/components/store/AssistantChat";

export const dynamic = "force-dynamic";
export const metadata = {
  title: `${config.storeName} — Order anything from China, shipped to Canada`,
  description:
    "Canadian B2B sourcing: describe what you're building and our assistant finds every part from Chinese factories, fills your cart, and shows shipping before you pay.",
};

const STEPS = [
  { n: "1", h: "Describe it", p: "Tell the assistant what you’re building or stocking, in plain words." },
  { n: "2", h: "Get the full list", p: "It plans every part, connector and tool, then finds each one from factories in China." },
  { n: "3", h: "Check out once", p: "Approve the cart, see shipping to your postal code, pay. We order from the factory." },
];

const PROMISES = [
  { h: "Factory-direct", p: "Millions of products straight from Chinese suppliers, priced without the middlemen." },
  { h: "Bulk-ready", p: "Order one unit or a pallet. Stock is checked live before you pay." },
  { h: "Shipping upfront", p: "Your real shipping cost to Canada is shown in the cart, never a surprise." },
];

export default function Home() {
  return (
    <>
      <section className="hero ai-hero">
        <div className="wrap ai-hero-grid">
          <div className="ai-hero-copy">
            <p className="eyebrow">B2B sourcing for Canada 🍁</p>
            <h1>Order anything from China.</h1>
            <p className="hero-lede">
              Describe your project. Our assistant builds the parts list, finds every item from Chinese factories, and fills
              your cart.
            </p>
            <div className="hero-ctas">
              <Link href="/search" className="btn ghost lg">
                Or search the catalog
              </Link>
            </div>
          </div>
          <div className="ai-hero-chat">
            <AssistantChat />
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <p className="eyebrow">How it works</p>
          <h2 className="section-title">From idea to cart in one conversation.</h2>
          <div className="steps">
            {STEPS.map((s) => (
              <div key={s.n} className="how-step">
                <span className="how-step-n">{s.n}</span>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="band band-tight">
        <div className="wrap promise-row">
          {PROMISES.map((x) => (
            <div key={x.h}>
              <h3>{x.h}</h3>
              <p>{x.p}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
