import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { activeSessionCount, getMember, safeNext } from "@/lib/session";
import { getVisitorId } from "@/lib/chat-session";
import { aiAllowance, getLimits } from "@/lib/membership";
import { countryLabel } from "@/lib/shipping";
import { STAGE_LABEL, type TrackingStage } from "@/lib/carriers";
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

/** A word for how much AI allowance is left (never the number). */
function allowanceWord(remaining: number, limit: number): string {
  if (remaining <= 0) return "Used up for now; it refills over the month";
  const share = limit > 0 ? remaining / limit : 0;
  return share > 0.5 ? "Plenty left" : share > 0.15 ? "Some left" : "Almost used up";
}

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
        {why === "subscribe" && <p className="notice ok">Sign in with your email first, then you’ll go straight to checkout. Your subscription is saved to this account.</p>}
        <p>Sign in to see your subscription, your orders, your AI chats on any device and your AI allowance. No password: we email you a 6-digit code.</p>
        <SignInForm next={safeNext(next)} />
        <div className="account-cta">
          <strong>New here?</strong> Full gives you twice the assistant usage and a surplus mystery box every month.{" "}
          <Link href="/plans">See plans →</Link>
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
  const pct = allowance.limit ? Math.min(100, Math.round((allowance.used / allowance.limit) * 100)) : 100;

  return (
    <div className="wrap page narrow account">
      <h1 className="page-title">Your account</h1>
      {welcome && <p className="notice ok">You’re subscribed. If your plan includes a box, your first one is being packed; we’ll email you when it ships.</p>}
      {error && <p className="notice err">{error}</p>}
      <p className="muted">
        Signed in as <strong>{member.email}</strong>
      </p>

      <section className="account-card">
        <h2 className="section-title">Your plan</h2>
        {subs.length === 0 ? (
          <p>
            No subscription yet. <Link href="/plans">See plans</Link>: Lite for the assistant, or Full for twice the usage and a surplus mystery box every month.
          </p>
        ) : (
          <ul className="sub-list">
            {subs.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>{s.plan === "lite" ? "Lite" : "Full"}</strong> <span className={`pill ${s.status === "active" || s.status === "trialing" ? "pill-ok" : ""}`}>{STATUS[s.status] ?? s.status}</span>
                </div>
                <div className="muted small">
                  {formatMoney(s.priceCents)}/month
                  {s.plan === "lite"
                    ? " · the assistant"
                    : s.monthlyBox
                      ? ` + ${formatMoney(s.shippingCents)} shipping · ${s.boxName} surplus box every month, to ${countryLabel(s.shipCountry)}`
                      : ` · welcome box: ${s.boxName}`}
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
        <h2 className="section-title">Shopping assistant</h2>
        {/* How much is left, as a bar and a word: customers never see message counts. */}
        <div className="ai-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={100 - pct} aria-label="Assistant use left this month">
          <span style={{ width: `${100 - pct}%` }} />
        </div>
        <p>
          <strong>{allowanceWord(allowance.remaining, allowance.limit)}</strong>
          {allowance.subscriber ? (allowance.basis === "lite" ? " · Lite plan" : "") : " · free preview"}
        </p>
        {allowance.basis === "full" && <p className="muted small">Full gives you twice Lite’s usage, and it refills over the month.</p>}
        {allowance.basis === "lite" && (
          <p className="muted small">
            Quick questions use less than big shopping searches. <Link href="/plans">Upgrade to Full</Link> for twice the usage and a surplus mystery box every month.
          </p>
        )}
        {!allowance.subscriber && (
          <p className="muted small">
            <Link href="/plans">Pick a plan</Link> to keep your shopping assistant.
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
                <span className={`trk-chip trk-chip-${o.status === "DECLINED_REFUNDED" ? "off" : (o.trackingStage ?? "waiting")}`}>
                  {o.status === "DECLINED_REFUNDED" ? "Refunded" : o.trackingStage ? STAGE_LABEL[o.trackingStage as TrackingStage] : "Preparing"}
                </span>
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
