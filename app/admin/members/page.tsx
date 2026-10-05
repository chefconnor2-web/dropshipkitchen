// Members: mystery box subscribers and their AI assistant limits.
import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Flash, timeAgo } from "@/components/admin";
import { COUNTED_ORDER } from "@/lib/customers";
import { WINDOW_MS, getLimits } from "@/lib/membership";
import { syncSubscriptions } from "@/lib/subscriptions";
import { config } from "@/lib/config";
import { saveAiLimits, saveLitePlanAction, savePlanAction, setMemberLimit, syncSubscriptionsAction } from "@/app/admin/actions";
import { getLitePlan, getPlan, liteAiBudgetMicros, maxBoxCostCents, planRules, stripeFeeCents } from "@/lib/plan";
import { FULL_USAGE_MULTIPLIER, averageMessageMicros, messagesFor, planAiBudgetMicros } from "@/lib/membership";
import { loadPool, simulate } from "@/lib/mystery";

export const dynamic = "force-dynamic";

const LAST_SYNC = "subs.lastSync";
const LIVE = ["active", "trialing", "past_due"];

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  // Without the Stripe webhook, renewals become box orders here: catch up in the background every 15 minutes.
  const last = await prisma.setting.findUnique({ where: { key: LAST_SYNC } });
  if (!last || Date.now() - new Date(last.value).getTime() > 15 * 60_000) {
    const now = new Date().toISOString();
    await prisma.setting.upsert({ where: { key: LAST_SYNC }, create: { key: LAST_SYNC, value: now }, update: { value: now } });
    void syncSubscriptions().catch(() => null);
  }

  const [limits, plan, lite, avg] = await Promise.all([getLimits(), getPlan(), getLitePlan(), averageMessageMicros()]);
  const liteBudget = liteAiBudgetMicros(lite);
  const liteMessages = messagesFor(liteBudget, avg.micros);
  const fullMessages = messagesFor(planAiBudgetMicros("full", lite), avg.micros);
  // Can each published box be drawn within the plan's margin? (Welcome boxes are drawn under these rules.)
  const boxes = await prisma.mysteryBox.findMany({ where: { status: "PUBLISHED" }, orderBy: { name: "asc" } });
  const boxHealth = await Promise.all(boxes.map(async (b) => ({ b, stats: simulate(await loadPool(b.id), planRules(b, plan), 200) })));
  const since = new Date(Date.now() - WINDOW_MS);
  const members = await prisma.customer.findMany({
    where: { OR: [{ subscriptions: { some: {} } }, { aiLimitOverride: { not: null } }] },
    include: {
      subscriptions: { orderBy: { createdAt: "desc" } },
      orders: { where: COUNTED_ORDER, select: { subtotalCents: true, shippingCents: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
  const months = new Map(
    (await prisma.subscriptionPayment.groupBy({ by: ["customerId"], where: { customerId: { in: members.map((m) => m.id) } }, _sum: { amountCents: true } })).map((p) => [p.customerId, p._sum.amountCents ?? 0]),
  );
  const usage = new Map(
    (await prisma.aiUsage.groupBy({ by: ["customerId"], where: { customerId: { in: members.map((m) => m.id) }, createdAt: { gte: since } }, _count: true })).map((u) => [u.customerId, u._count]),
  );
  const rows = members.map((m) => {
    // Lifetime spend: paid orders (box orders included) plus subscription months without a box.
    const spend = m.orders.reduce((n, o) => n + o.subtotalCents + o.shippingCents, 0) + (months.get(m.id) ?? 0);
    const live = m.subscriptions.filter((s) => LIVE.includes(s.status));
    const liteOnly = live.length > 0 && live.every((s) => s.plan === "lite");
    const planLimit = liteOnly ? liteMessages : live.length ? fullMessages : limits.freeMessages;
    const limit = m.aiLimitOverride ?? planLimit;
    return { m, spend, live, planLimit, limit, used: usage.get(m.id) ?? 0 };
  });
  const active = rows.filter((r) => r.live.length);
  // Lite's real margin over the last 30 days: what Lite subscribers paid vs. what their AI cost us (and Stripe's fees).
  const liteIds = rows.filter((r) => r.live.length && r.live.every((s) => s.plan === "lite")).map((r) => r.m.id);
  const liteAi = liteIds.length ? await prisma.aiUsage.aggregate({ where: { customerId: { in: liteIds }, createdAt: { gte: since } }, _sum: { costMicros: true } }) : null;
  const liteRevenue = liteIds.length * lite.priceCents;
  const liteCostCents = (liteAi?._sum.costMicros ?? 0) / 10_000 + liteIds.length * stripeFeeCents(lite.priceCents);
  const mrr = active.reduce((n, r) => n + r.live.reduce((k, s) => k + s.priceCents, 0), 0);

  return (
    <>
      <div className="row between">
        <h1>Members</h1>
        <form action={syncSubscriptionsAction}>
          <button className="btn">Sync with Stripe</button>
        </form>
      </div>
      <Flash notice={notice} error={error} />
      <p className="muted small">
        The AI assistant is a monthly subscription. A new subscriber’s first payment (first month + shipping) includes a free welcome mystery box, which becomes a box order in{" "}
        <Link href="/admin/orders">Orders</Link> for you to approve; later months are the assistant only.
        {config.stripe.webhookSecret
          ? " Renewals arrive through the Stripe webhook."
          : " The Stripe webhook isn’t set up, so new subscriptions and renewals are picked up when this page syncs (every 15 minutes while you use it, or with the button). Add STRIPE_WEBHOOK_SECRET to get them instantly."}
      </p>

      <div className="stat-row">
        <div className="a-card stat">
          <div className="muted small">Active subscribers</div>
          <strong>{active.length}</strong>
        </div>
        <div className="a-card stat">
          <div className="muted small">Monthly revenue</div>
          <strong>{formatMoney(mrr)}</strong>
        </div>
      </div>

      <section className="a-card">
        <h2 className="a-h2">Full plan (assistant + monthly surplus box)</h2>
        <form action={savePlanAction} className="row gap plan-form">
          <label>
            Price per month ($)
            <input name="price" type="number" min={5} step="0.01" defaultValue={(plan.priceCents / 100).toFixed(2)} />
          </label>
          <label>
            Box margin (%)
            <input name="margin" type="number" min={0} max={95} step="1" defaultValue={plan.marginPct} />
          </label>
          <button className="btn primary">Save plan</button>
        </form>
        <p className="muted small">
          Each month’s box products may cost at most {formatMoney(maxBoxCostCents(plan))} ({100 - plan.marginPct}% of {formatMoney(plan.priceCents)}); shipping is billed to the subscriber every month on top, at
          cost. Every box is worth at least {formatMoney(plan.priceCents)} at list price.
        </p>
        <table className="table small">
          <thead>
            <tr>
              <th>Box</th>
              <th>Draws that fit the plan</th>
              <th>Average product cost</th>
              <th>Average margin</th>
            </tr>
          </thead>
          <tbody>
            {boxHealth.map(({ b, stats }) => (
              <tr key={b.id}>
                <td>
                  <Link href={`/admin/boxes/${b.id}`}>{b.name}</Link> <span className="muted">· {b.itemCount} items</span>
                </td>
                <td className={stats.successRate > 0.5 ? "ok-text" : "err-text"}>{Math.round(stats.successRate * 100)}%{stats.successRate === 0 ? " (shown as sold out)" : ""}</td>
                <td>{stats.successRate ? formatMoney(plan.priceCents - stats.avgProfitCents) : "—"}</td>
                <td>{stats.successRate ? `${Math.round((stats.avgProfitCents / plan.priceCents) * 100)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Boxes built before the plan may hold items too expensive for it: rebuild them in Boxes (the builder now picks within the plan).</p>
      </section>

      <section className="a-card">
        <h2 className="a-h2">Lite plan (AI only)</h2>
        <form action={saveLitePlanAction} className="row gap plan-form">
          <label className="row gap">
            <input name="enabled" type="checkbox" defaultChecked={lite.enabled} /> Offered
          </label>
          <label>
            Price per month ($)
            <input name="price" type="number" min={1} step="0.01" defaultValue={(lite.priceCents / 100).toFixed(2)} />
          </label>
          <label>
            Margin after AI and Stripe fees (%)
            <input name="margin" type="number" min={0} max={99} step="1" defaultValue={lite.marginPct} />
          </label>
          <button className="btn primary">Save Lite</button>
        </form>
        <p className="muted small">
          {formatMoney(lite.priceCents)} − {lite.marginPct}% margin ({formatMoney(Math.round((lite.priceCents * lite.marginPct) / 100))}) − Stripe fee ({formatMoney(stripeFeeCents(lite.priceCents))}) leaves{" "}
          <strong>{(liteBudget / 10_000).toFixed(1)}¢</strong> of AI per subscriber per 30 days. Each Lite subscriber is cut off once their measured AI cost reaches that.
          {liteBudget === 0 && <strong className="err-text"> At this price and margin there’s no AI budget left: raise the price or lower the margin.</strong>}
        </p>
        <p className="muted small">
          Average AI message: <strong>{(avg.micros / 10_000).toFixed(2)}¢</strong>{" "}
          {avg.measured >= 10 ? `(measured over the last ${Math.min(300, avg.measured)} messages)` : "(a cautious estimate until 10 messages have been measured)"}, so Lite is about{" "}
          <strong>{liteMessages} messages a month</strong>.
        </p>
        {liteIds.length > 0 && (
          <p className="small">
            Last 30 days: {liteIds.length} Lite subscriber{liteIds.length === 1 ? "" : "s"}, {formatMoney(liteRevenue)} revenue, {formatMoney(Math.round(liteCostCents))} AI + fees →{" "}
            <strong>{Math.round((1 - liteCostCents / liteRevenue) * 100)}% margin</strong>.
          </p>
        )}
      </section>

      <section className="a-card">
        <h2 className="a-h2">AI assistant limits</h2>
        <form action={saveAiLimits} className="limits-form">
          <label>
            Free messages for people without a subscription
            <input name="freeMessages" type="number" min={0} max={1000} defaultValue={limits.freeMessages} />
          </label>
          <div className="small muted">
            Subscribers get an AI budget per 30 days, capped so no plan loses money: Lite {(liteBudget / 10_000).toFixed(0)}¢ (about {liteMessages} messages), Full {FULL_USAGE_MULTIPLIER}× that,{" "}
            {(planAiBudgetMicros("full", lite) / 10_000).toFixed(0)}¢ (about {fullMessages} messages). Change Lite’s price or margin above to move both. Customers never see these numbers.
          </div>
          <button className="btn primary">Save limits</button>
        </form>
      </section>

      <section className="a-card">
        <h2 className="a-h2">Members ({rows.length})</h2>
        {rows.length === 0 ? (
          <p className="muted">No subscribers yet.</p>
        ) : (
          <table className="table small">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Subscription</th>
                <th>Spent</th>
                <th>AI used (30 d)</th>
                <th>Limit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ m, spend, planLimit, limit, used }) => (
                <tr key={m.id}>
                  <td>
                    <Link href={`/admin/customers/${m.id}`}>{m.name || m.email}</Link>
                    {m.name && <div className="muted">{m.email}</div>}
                  </td>
                  <td>
                    {m.subscriptions.map((s) => (
                      <div key={s.id}>
                        {s.boxName} <span className={`pill ${LIVE.includes(s.status) ? "pill-ok" : ""}`}>{s.status}</span>
                        <div className="muted">
                          {formatMoney(s.priceCents)}/mo{s.cancelAtPeriodEnd ? " · cancels at period end" : ""} · since {timeAgo(s.createdAt)}
                        </div>
                      </div>
                    ))}
                  </td>
                  <td>{formatMoney(spend)}</td>
                  <td>
                    {used} / {limit}
                  </td>
                  <td>
                    <form action={setMemberLimit} className="row gap">
                      <input type="hidden" name="customerId" value={m.id} />
                      <input name="limit" type="number" min={0} defaultValue={m.aiLimitOverride ?? ""} placeholder={`${planLimit} (plan)`} style={{ width: 110 }} aria-label="Custom limit" />
                      <button className="btn tiny">Set</button>
                    </form>
                    <div className="muted">{m.aiLimitOverride != null ? "custom" : "by spend"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Leave a limit empty to use their plan’s budget.</p>
      </section>
    </>
  );
}
