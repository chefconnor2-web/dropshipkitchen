import Link from "next/link";
import { getLitePlan, getPlan, liteAiBudgetMicros } from "@/lib/plan";
import { averageMessageMicros, getLimits, messagesFor } from "@/lib/membership";
import { config } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { subscribeLite } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: `Plans — ${config.storeName}` };

export default async function PlansPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const [plan, lite, limits, avg] = await Promise.all([getPlan(), getLitePlan(), getLimits(), averageMessageMicros()]);
  // Lite's allowance is an AI cost budget; shown as messages at today's average cost of a message.
  const liteMessages = messagesFor(liteAiBudgetMicros(lite), avg.micros);
  return (
    <>
      <section className="band band-dark search-hero">
        <div className="wrap">
          <p className="eyebrow">AI sourcing assistant</p>
          <h1 className="section-title">Pick a plan</h1>
          <p className="section-lede">Everyone gets {limits.freeMessages} free messages to try it. Subscribe to keep going.</p>
        </div>
      </section>
      <section className="band">
        <div className="wrap">
          {error && <p className="notice err">{error}</p>}
          <div className="plan-grid">
            {lite.enabled && (
              <div className="plan-card">
                <h2>Lite</h2>
                <p className="plan-price">
                  <strong>{formatMoney(lite.priceCents)}</strong>/month
                </p>
                <ul>
                  <li>About {liteMessages} AI messages a month</li>
                  <li>Search, compare and add to cart from the chat</li>
                  <li>No mystery box</li>
                </ul>
                <form action={subscribeLite}>
                  <button className="btn block">Subscribe to Lite</button>
                </form>
                <p className="muted small">Short questions use less of your allowance than big sourcing searches.</p>
              </div>
            )}
            <div className="plan-card plan-card-main">
              <h2>Full</h2>
              <p className="plan-price">
                <strong>{formatMoney(plan.priceCents)}</strong>/month
              </p>
              <ul>
                <li>{limits.tiers[0].limit} AI messages a month, more as you spend</li>
                <li>A free mystery box with your first month (you pay its shipping)</li>
                <li>Everything in Lite</li>
              </ul>
              <Link href="/boxes" className="btn primary block">
                Pick your free box
              </Link>
            </div>
          </div>
          <p className="muted small">Cancel any time from your account. You sign in with your email before checkout.</p>
        </div>
      </section>
    </>
  );
}
