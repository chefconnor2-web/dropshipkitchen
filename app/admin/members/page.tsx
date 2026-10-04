// Members: mystery box subscribers and their AI assistant limits.
import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Flash, timeAgo } from "@/components/admin";
import { COUNTED_ORDER } from "@/lib/customers";
import { WINDOW_MS, getLimits, tierFor } from "@/lib/membership";
import { syncSubscriptions } from "@/lib/subscriptions";
import { config } from "@/lib/config";
import { saveAiLimits, setMemberLimit, syncSubscriptionsAction } from "@/app/admin/actions";

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

  const limits = await getLimits();
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
  const usage = new Map(
    (await prisma.aiUsage.groupBy({ by: ["customerId"], where: { customerId: { in: members.map((m) => m.id) }, createdAt: { gte: since } }, _count: true })).map((u) => [u.customerId, u._count]),
  );
  const rows = members.map((m) => {
    const spend = m.orders.reduce((n, o) => n + o.subtotalCents + o.shippingCents, 0);
    const live = m.subscriptions.filter((s) => LIVE.includes(s.status));
    const tierLimit = tierFor(spend, limits.tiers).limit;
    const limit = m.aiLimitOverride ?? (live.length ? tierLimit : limits.freeMessages);
    return { m, spend, live, tierLimit, limit, used: usage.get(m.id) ?? 0 };
  });
  const active = rows.filter((r) => r.live.length);
  const mrr = active.reduce((n, r) => n + r.live.reduce((k, s) => k + s.priceCents + s.shippingCents, 0), 0);
  const tierRows = [...limits.tiers, ...Array(Math.max(0, 4 - limits.tiers.length)).fill(null)].slice(0, 6);

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
        Mystery boxes are sold as monthly subscriptions. Each paid month becomes a box order in <Link href="/admin/orders">Orders</Link> for you to approve.
        {config.stripe.webhookSecret
          ? " Renewals arrive through the Stripe webhook."
          : " The Stripe webhook isn’t set up, so renewals are picked up when this page syncs (every 15 minutes while you use it, or with the button). Add STRIPE_WEBHOOK_SECRET for instant renewals."}
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
        <h2 className="a-h2">AI assistant limits</h2>
        <form action={saveAiLimits} className="limits-form">
          <label>
            Free messages for people without a subscription
            <input name="freeMessages" type="number" min={0} max={1000} defaultValue={limits.freeMessages} />
          </label>
          <div className="small muted">Subscribers: messages per 30 days, by lifetime spend (orders, boxes included). People move up automatically as they spend.</div>
          <table className="table small">
            <thead>
              <tr>
                <th>Spent at least ($)</th>
                <th>Messages / 30 days</th>
              </tr>
            </thead>
            <tbody>
              {tierRows.map((t, i) => (
                <tr key={i}>
                  <td>
                    <input name={`tierSpend_${i}`} type="number" min={0} step="1" defaultValue={t ? t.minSpendCents / 100 : ""} readOnly={i === 0} aria-label={`Tier ${i + 1} spend`} />
                  </td>
                  <td>
                    <input name={`tierLimit_${i}`} type="number" min={0} defaultValue={t ? t.limit : ""} aria-label={`Tier ${i + 1} messages`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
              {rows.map(({ m, spend, tierLimit, limit, used }) => (
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
                          {formatMoney(s.priceCents + s.shippingCents)}/mo{s.cancelAtPeriodEnd ? " · cancels at period end" : ""} · since {timeAgo(s.createdAt)}
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
                      <input name="limit" type="number" min={0} defaultValue={m.aiLimitOverride ?? ""} placeholder={`${tierLimit} (tier)`} style={{ width: 110 }} aria-label="Custom limit" />
                      <button className="btn tiny">Set</button>
                    </form>
                    <div className="muted">{m.aiLimitOverride != null ? "custom" : "by spend"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">Leave a limit empty to use their spend tier.</p>
      </section>
    </>
  );
}
