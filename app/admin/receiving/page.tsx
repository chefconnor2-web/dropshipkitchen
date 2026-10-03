import Link from "next/link";
import { prisma } from "@/lib/db";
import { config, labelReaderConfigured } from "@/lib/config";
import { Flash, fmtTime } from "@/components/admin";
import { CONDITIONS, isCondition } from "@/lib/receiving/conditions";
import { fmtDay } from "@/lib/receiving/dates";
import { createDelivery } from "./actions";
import { ExpiryPill } from "./ui";

export default async function ReceivingPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const sp = await searchParams;
  const now = new Date();
  const horizon = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + config.receiving.expiringSoonDays));
  const [deliveries, expiring, issues] = await Promise.all([
    prisma.receivingDelivery.findMany({
      orderBy: { receivedAt: "desc" },
      take: 100,
      include: { cases: { select: { quantity: true, condition: true, expiryDate: true } } },
    }),
    prisma.receivedCase.findMany({
      where: { expiryDate: { lte: horizon, gte: new Date(horizon.getTime() - 14 * 86_400_000) } },
      orderBy: { expiryDate: "asc" },
      include: { delivery: { select: { supplier: true, receivedAt: true } } },
      take: 50,
    }),
    prisma.receivedCase.findMany({
      where: { condition: { not: "OK" }, createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
      orderBy: { createdAt: "desc" },
      include: { delivery: { select: { supplier: true, receivedAt: true } } },
      take: 50,
    }),
  ]);

  return (
    <>
      <h1>Receiving</h1>
      <p className="muted narrow">
        Snap the sticker on every box that comes in. The item number, description, pack and lot are read off the photo, then
        add the expiry date from the product itself — type it, or snap the date.
      </p>
      <Flash notice={sp.notice} error={sp.error} />
      {!labelReaderConfigured() && (
        <p className="notice">
          Photo reading is off (<code>ANTHROPIC_API_KEY</code> isn&apos;t set). Photos are still saved; type the sticker details by hand.
        </p>
      )}

      <form action={createDelivery} className="card pad receive-new">
        <h3>NEW DELIVERY</h3>
        <div className="row gap">
          <label className="grow">
            Supplier
            <input name="supplier" defaultValue="GFS" />
          </label>
          <label className="grow">
            Invoice # (optional)
            <input name="invoiceNumber" inputMode="numeric" />
          </label>
          <label className="grow">
            Received by
            <input name="receivedBy" />
          </label>
        </div>
        <button className="btn primary">Start receiving</button>
      </form>

      <h2>Use first — expiring within {config.receiving.expiringSoonDays} days</h2>
      {expiring.length === 0 ? (
        <p className="muted">Nothing received is close to its date.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Expires</th>
              <th>Item</th>
              <th>Lot</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {expiring.map((c) => (
              <tr key={c.id}>
                <td>
                  <ExpiryPill date={c.expiryDate} />
                </td>
                <td>
                  <Link href={`/admin/receiving/cases/${c.id}`}>{c.description ?? "Unnamed item"}</Link>
                  {c.itemCode && <span className="muted small"> #{c.itemCode}</span>}
                  {c.quantity > 1 && <span className="muted small"> ×{c.quantity}</span>}
                </td>
                <td className="small">{c.lotCode ?? "—"}</td>
                <td className="small">
                  {c.delivery.supplier} · {fmtDay(c.delivery.receivedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {issues.length > 0 && (
        <>
          <h2>Problems in the last 30 days</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Item</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="pill pill-issue">{isCondition(c.condition) ? CONDITIONS[c.condition] : c.condition}</span>
                    {c.issueQuantity && <span className="small"> {c.issueQuantity} of {c.quantity}</span>}
                  </td>
                  <td>
                    <Link href={`/admin/receiving/cases/${c.id}`}>{c.description ?? "Unnamed item"}</Link>
                    {c.itemCode && <span className="muted small"> #{c.itemCode}</span>}
                  </td>
                  <td className="small">
                    {c.delivery.supplier} · {fmtDay(c.delivery.receivedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Deliveries</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Received</th>
            <th>Supplier</th>
            <th>Invoice</th>
            <th>Boxes</th>
            <th>Missing expiry</th>
            <th>Problems</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => {
            const boxes = d.cases.reduce((n, c) => n + c.quantity, 0);
            const noExpiry = d.cases.filter((c) => !c.expiryDate).length;
            const problems = d.cases.filter((c) => c.condition !== "OK").length;
            return (
              <tr key={d.id}>
                <td>
                  <Link href={`/admin/receiving/${d.id}`}>{fmtTime(d.receivedAt)}</Link>
                </td>
                <td>{d.supplier}</td>
                <td className="small">{d.invoiceNumber ?? "—"}</td>
                <td>{boxes}</td>
                <td className={noExpiry ? "warn-text" : "muted"}>{noExpiry || "—"}</td>
                <td className={problems ? "err-text" : "muted"}>{problems || "—"}</td>
              </tr>
            );
          })}
          {deliveries.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No deliveries yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
