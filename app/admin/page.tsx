import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { cjBalanceCents, supplierMode } from "@/lib/fulfillment";
import { CjStatusPanel, StatusChip, fmtTime, timeAgo } from "@/components/admin";
import { emailConfigured } from "@/lib/email";

export default async function AdminHome() {
  const since = new Date(Date.now() - 30 * 86400_000);
  const [awaiting, waitingOrders, paid30, published, calls, waitlist, lastEmail, freightNew, liveBoxes] = await Promise.all([
    prisma.order.count({ where: { status: "AWAITING_MERCHANT_APPROVAL" } }),
    prisma.order.findMany({ where: { status: "AWAITING_MERCHANT_APPROVAL" }, orderBy: { paidAt: "asc" }, take: 3, include: { items: true } }),
    prisma.order.findMany({ where: { paidAt: { gte: since }, status: { notIn: ["DECLINED_REFUNDED", "PENDING_PAYMENT"] } }, select: { subtotalCents: true } }),
    prisma.product.count({ where: { status: "PUBLISHED" } }),
    prisma.cjApiCall.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
    prisma.waitlistEntry.count(),
    prisma.emailLog.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.freightRequest.count({ where: { status: "new" } }),
    prisma.mysteryBox.count({ where: { status: "PUBLISHED" } }),
  ]);
  const balance = supplierMode() === "live" ? await cjBalanceCents() : null;
  const revenue = paid30.reduce((n, o) => n + o.subtotalCents, 0);

  return (
    <>
      <div className="a-head">
        <h1>Dashboard</h1>
      </div>
      <div className="kpis">
        <Link href="/admin/orders?show=action" className={`kpi ${awaiting ? "kpi-action" : ""}`}>
          <span className="kpi-v">{awaiting}</span>
          <span className="kpi-k">Need approval</span>
        </Link>
        <div className="kpi">
          <span className="kpi-v">{formatMoney(revenue)}</span>
          <span className="kpi-k">Sales, last 30 days ({paid30.length})</span>
        </div>
        <Link href="/admin/products" className="kpi">
          <span className="kpi-v">{published}</span>
          <span className="kpi-k">Products live</span>
        </Link>
        <Link href="/admin/freight" className={`kpi ${freightNew ? "kpi-action" : ""}`}>
          <span className="kpi-v">{freightNew}</span>
          <span className="kpi-k">Freight requests</span>
        </Link>
        <Link href="/admin/boxes" className="kpi">
          <span className="kpi-v">{liveBoxes}</span>
          <span className="kpi-k">Mystery boxes live</span>
        </Link>
        <Link href="/admin/waitlist" className="kpi">
          <span className="kpi-v">{waitlist}</span>
          <span className="kpi-k">Link line waitlist</span>
        </Link>
        {balance != null && (
          <div className="kpi">
            <span className="kpi-v">{formatMoney(balance)}</span>
            <span className="kpi-k">CJ wallet balance</span>
          </div>
        )}
      </div>

      {waitingOrders.length > 0 && (
        <section className="a-card">
          <div className="a-card-head">
            <h2 className="a-h2">Waiting on you</h2>
            <Link href="/admin/orders?show=action" className="small">
              See all
            </Link>
          </div>
          <ul className="mini-list">
            {waitingOrders.map((o) => (
              <li key={o.id}>
                <Link href={`/admin/orders/${o.id}`}>
                  <span className="strong">{o.customerName || o.email || o.number}</span>
                  <span className="muted small">
                    {o.items[0]?.productTitle}
                    {o.items.length > 1 ? ` + ${o.items.length - 1}` : ""} · {timeAgo(o.paidAt)}
                  </span>
                  <span className="mini-right">
                    {formatMoney(o.subtotalCents)} <StatusChip status={o.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href="/admin/emails" className="a-card email-home">
        <div className="a-card-head">
          <h2 className="a-h2">Customer emails</h2>
          <span className={`chip-status ${emailConfigured() ? "tone-good" : "tone-warn"}`}>{emailConfigured() ? "Sending" : "Not set up"}</span>
        </div>
        <p className="small muted">
          {lastEmail ? `Last: “${lastEmail.subject}” · ${timeAgo(lastEmail.createdAt)}` : "Order confirmations, tracking and refunds."} Send a test ›
        </p>
      </Link>

      <CjStatusPanel back="/admin" />

      <details className="a-card a-details">
        <summary>CJ API log (last {calls.length} calls)</summary>
        <div className="a-details-body">
          <p className="muted small">Every request this store makes to CJ’s official API.</p>
          <ul className="log-list">
            {calls.map((c) => (
              <li key={c.id} className={c.ok ? "" : "log-fail"}>
                <div>
                  <code>
                    {c.method} {c.path}
                  </code>
                </div>
                <div className="muted small">
                  {fmtTime(c.createdAt)} · HTTP {c.httpStatus ?? "—"} · {c.durationMs} ms · {c.ok ? "OK" : c.message}
                </div>
              </li>
            ))}
            {calls.length === 0 && <li className="muted">No calls yet.</li>}
          </ul>
        </div>
      </details>
    </>
  );
}
