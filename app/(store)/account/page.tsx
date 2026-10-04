import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { activeSessionCount, getMember, safeNext } from "@/lib/session";
import { getVisitorId } from "@/lib/chat-session";
import { aiAllowance, getLimits, tierFor } from "@/lib/membership";
import { countryLabel } from "@/lib/shipping";
import { openBillingPortal, signOutAction, signOutEverywhereAction } from "../actions";
import SignInForm from "./SignInForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your account" };

const STATUS: Record<string, string> = {
  active: "Active",
  trialing: "Active",
  past_due: "Payment failed: update your card",
  unpaid: "Paused: payment failed",
  canceled: "Cancelled",
  incomplete: "Waiting for payment",
  incomplete_expired: "Not started",
  paused: "Paused",
};

const fmtDate = (d: Date) => d.toLocaleDateString("en-CA", { month: "long", day: "numeric" });

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ welcome?: string; error?: string; next?: string; why?: string; signedout?: string }> }) {
  const { welcome, error, next, why, signedout } = await searchParams;
  const member = await getMember();
  if (!member) {
    return (
      <div className="wrap page narrow account">
        <h1 className="page-title">Your account</h1>
        {error && <p className="notice err">{error}</p>}
        {signedout && <p className="notice ok">You’re signed out on every device.</p>}
        {why === "subscribe" && <p className="notice ok">Sign in with your email first, then you’ll go straight to checkout. Your subscription and free box are saved to this account.</p>}
        <p>Sign in to see your subscription, your orders, your AI chats on any device and your AI allowance. No password: we email you a 6-digit code.</p>
        <SignInForm next={safeNext(next)} />
        <div className="account-cta">
          <strong>New here?</strong> Subscribe to the AI sourcing assistant and get your first mystery box free.{" "}
          <Link href="/boxes">Pick your box →</Link>
        </div>
      </div>
    );
  }

  const [subs, orders, allowance, limits, devices] = await Promise.all([
    prisma.subscription.findMany({ where: { customerId: member.id }, orderBy: { createdAt: "desc" } }),
    prisma.order.findMany({ where: { customerId: member.id, status: { not: "PENDING_PAYMENT" } }, orderBy: { createdAt: "desc" }, take: 10 }),
    aiAllowance({ customerId: member.id, visitorId: await getVisitorId() }),
    getLimits(),
    activeSessionCount(member.id),
  ]);
  const nextTier = allowance.subscriber && allowance.basis === "tier" ? limits.tiers.find((t) => t.minSpendCents > allowance.spendCents) : undefined;
  const pct = allowance.limit ? Math.min(100, Math.round((allowance.used / allowance.limit) * 100)) : 100;

  return (
    <div className="wrap page narrow account">
      <h1 className="page-title">Your account</h1>
      {welcome && <p className="notice ok">You’re subscribed. Your free mystery box is being packed; we’ll email you when it ships.</p>}
      {error && <p className="notice err">{error}</p>}
      <p className="muted">
        Signed in as <strong>{member.email}</strong>
      </p>

      <section className="account-card">
        <h2 className="section-title">AI assistant subscription</h2>
        {subs.length === 0 ? (
          <p>
            No subscription yet. <Link href="/boxes">Subscribe to the AI assistant</Link> and your first mystery box is free (you just pay its shipping).
          </p>
        ) : (
          <ul className="sub-list">
            {subs.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>AI assistant</strong> <span className={`pill ${s.status === "active" || s.status === "trialing" ? "pill-ok" : ""}`}>{STATUS[s.status] ?? s.status}</span>
                </div>
                <div className="muted small">
                  {formatMoney(s.priceCents)}/month · free welcome box: {s.boxName} (shipping to {countryLabel(s.shipCountry)} paid)
                  {s.currentPeriodEnd && s.status !== "canceled" && (s.cancelAtPeriodEnd ? ` · ends ${fmtDate(s.currentPeriodEnd)}` : ` · renews ${fmtDate(s.currentPeriodEnd)}`)}
                </div>
              </li>
            ))}
          </ul>
        )}
        {member.stripeCustomerId && (
          <form action={openBillingPortal}>
            <button className="btn">Manage billing, address or cancel</button>
          </form>
        )}
      </section>

      <section className="account-card">
        <h2 className="section-title">AI assistant</h2>
        <div className="ai-meter" role="meter" aria-valuemin={0} aria-valuemax={allowance.limit} aria-valuenow={allowance.used} aria-label="AI messages used">
          <span style={{ width: `${pct}%` }} />
        </div>
        <p>
          <strong>{allowance.remaining}</strong> of {allowance.limit} messages left
          {allowance.subscriber ? " (last 30 days)" : " (free trial)"}.
        </p>
        {allowance.subscriber && allowance.basis === "tier" && (
          <p className="muted small">
            Your allowance grows with your orders: you’ve spent {formatMoney(allowance.spendCents)}, {tierFor(allowance.spendCents, limits.tiers).limit} messages a month.
            {nextTier && ` Spend ${formatMoney(nextTier.minSpendCents - allowance.spendCents)} more for ${nextTier.limit} a month.`}
          </p>
        )}
        {!allowance.subscriber && (
          <p className="muted small">
            <Link href="/boxes">Subscribe</Link> to keep using the assistant every month, with a free mystery box to start.
          </p>
        )}
        <Link href="/" className="btn">
          Open the assistant
        </Link>
      </section>

      {orders.length > 0 && (
        <section className="account-card">
          <h2 className="section-title">Orders</h2>
          <ul className="order-mini">
            {orders.map((o) => (
              <li key={o.id}>
                <Link href={`/orders/${encodeURIComponent(o.number)}`}>{o.number}</Link>
                <span className="muted small">{o.createdAt.toLocaleDateString("en-CA")}</span>
                <span>{formatMoney(o.subtotalCents + o.shippingCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="account-signout">
        <form action={signOutAction}>
          <button className="link-btn">Sign out</button>
        </form>
        {devices > 1 && (
          <form action={signOutEverywhereAction}>
            <button className="link-btn">Sign out on all {devices} devices</button>
          </form>
        )}
      </div>
    </div>
  );
}
