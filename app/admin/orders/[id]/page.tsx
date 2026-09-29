import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { stockLabel, stockStatus } from "@/lib/inventory";
import { previewSupplierOrderPayload } from "@/lib/orders";
import { Flash, Source, fmtTime } from "@/components/admin";
import { approveOrderAction, declineOrderAction, refreshOrderCj } from "@/app/admin/actions";

export default async function AdminOrder({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { id } = await params;
  const { notice, error } = await searchParams;
  const order = await prisma.order.findUnique({
    where: { id },
    include: { items: { include: { checks: { orderBy: { checkedAt: "desc" } } } } },
  });
  if (!order) notFound();

  const svs = await prisma.cjSupplierVariant.findMany({
    where: { cjVariantId: { in: order.items.map((i) => i.supplierVariantId) } },
  });
  const svByVid = new Map(svs.map((s) => [s.cjVariantId, s]));
  const ship = order.shippingAddressJson ? JSON.parse(order.shippingAddressJson) : null;
  const awaiting = order.status === "AWAITING_MERCHANT_APPROVAL";

  let costAtOrder = 0;
  let costKnown = true;
  for (const i of order.items) {
    if (i.supplierPriceAtOrderCents == null) costKnown = false;
    else costAtOrder += i.supplierPriceAtOrderCents * i.quantity;
  }

  return (
    <>
      <Link href="/admin/orders">← Orders</Link>
      <Flash notice={notice} error={error} />
      <div className="row between">
        <h1>Order {order.number}</h1>
        <span className={`pill pill-${order.status}`}>{order.status}</span>
      </div>
      <p className="small muted">
        Placed {fmtTime(order.createdAt)} · Paid {fmtTime(order.paidAt)} · {order.email ?? "no email"}
        {order.stripePaymentIntent && (
          <>
            {" "}
            · Stripe (test) <code>{order.stripePaymentIntent}</code>
          </>
        )}
      </p>
      {ship && (
        <p className="small">
          Ship to: {ship.name}, {[ship.address?.line1, ship.address?.line2, ship.address?.city, ship.address?.state, ship.address?.postal_code, ship.address?.country].filter(Boolean).join(", ")}
        </p>
      )}

      {order.items.map((i) => {
        const sv = svByVid.get(i.supplierVariantId);
        const lastCheck = i.checks[0];
        const currentPrice = lastCheck?.ok ? lastCheck.priceCents : sv?.supplierPriceCents ?? null;
        const currentInv = lastCheck?.ok ? lastCheck.inventoryTotal : sv?.inventoryTotal ?? null;
        const paid = i.customerPriceCents * i.quantity;
        const estCost = (currentPrice ?? i.supplierPriceAtOrderCents) != null ? (currentPrice ?? i.supplierPriceAtOrderCents)! * i.quantity : null;
        return (
          <div key={i.id} className="two-col order-item">
            <section className="card pad">
              <h3>CUSTOMER PURCHASE</h3>
              <Source kind="snapshot" />
              <div className="big">{i.productTitle}</div>
              <div>{i.variantName}</div>
              <div>Qty {i.quantity}</div>
              <div className="small muted">
                Our SKU <code>{i.internalSku}</code> · {formatMoney(i.customerPriceCents)} each
              </div>
              <p>
                Customer paid: <strong>{formatMoney(paid)}</strong>
              </p>
              {i.productId && (
                <Link className="small" href={`/admin/products/${i.productId}`}>
                  Current storefront product →
                </Link>
              )}
            </section>
            <section className="card pad supplier">
              <h3>SUPPLIER MAPPING</h3>
              <span className="muted small">Admin only — never shown to customers</span>
              <dl className="kv">
                <dt>Supplier</dt>
                <dd>{i.supplier}</dd>
                <dt>CJ PID</dt>
                <dd>
                  <code>{i.supplierProductId}</code>
                </dd>
                <dt>CJ VID</dt>
                <dd>
                  <code>{i.supplierVariantId}</code>
                </dd>
                <dt>CJ SKU</dt>
                <dd>
                  <code>{i.supplierSku}</code>
                </dd>
              </dl>
              <table className="table small compare">
                <thead>
                  <tr>
                    <th></th>
                    <th>
                      At customer order <Source kind="snapshot" />
                    </th>
                    <th>
                      Current <Source kind={lastCheck?.ok ? "live" : "cached"} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>CJ price</td>
                    <td>{formatMoney(i.supplierPriceAtOrderCents)}</td>
                    <td>
                      {formatMoney(currentPrice)}
                      {currentPrice != null && i.supplierPriceAtOrderCents != null && currentPrice !== i.supplierPriceAtOrderCents && (
                        <span className="err-text"> (changed)</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td>CJ inventory</td>
                    <td>
                      {stockLabel(stockStatus(i.supplierInventoryAtOrder))} ({i.supplierInventoryAtOrder ?? "?"})
                    </td>
                    <td>
                      {stockLabel(stockStatus(currentInv))} ({currentInv ?? "?"})
                    </td>
                  </tr>
                  <tr>
                    <td>Verified</td>
                    <td className="muted">{fmtTime(i.supplierInventoryCheckedAt)}</td>
                    <td className="muted">
                      {lastCheck ? `${fmtTime(lastCheck.checkedAt)}${lastCheck.ok ? "" : ` — FAILED: ${lastCheck.error}`}` : `cached ${fmtTime(sv?.inventoryCheckedAt)}`}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p>
                Estimated supplier cost: <strong>{formatMoney(estCost)}</strong> <span className="muted small">(excl. shipping)</span>
                <br />
                Estimated gross profit: <strong>{estCost != null ? formatMoney(paid - estCost) : "—"}</strong>
              </p>
            </section>
          </div>
        );
      })}

      <div className="card pad">
        <div className="row between">
          <div>
            Order total paid <strong>{formatMoney(order.subtotalCents)}</strong> · Supplier cost at order{" "}
            <strong>{costKnown ? formatMoney(costAtOrder) : "partly unknown"}</strong>
          </div>
          <form action={refreshOrderCj}>
            <input type="hidden" name="orderId" value={order.id} />
            <button className="btn">REFRESH CJ DATA</button>
          </form>
        </div>
      </div>

      {awaiting && (
        <div className="decision row gap">
          <form action={approveOrderAction}>
            <input type="hidden" name="orderId" value={order.id} />
            <button className="btn primary">APPROVE &amp; FULFILL (mock)</button>
          </form>
          <form action={declineOrderAction} className="row gap">
            <input type="hidden" name="orderId" value={order.id} />
            <input name="note" placeholder="Reason (optional)" />
            <button className="btn danger">DECLINE &amp; REFUND</button>
          </form>
        </div>
      )}
      {order.decisionNote && (
        <p className="notice">
          {order.decisionNote} {order.mockSupplierOrderId && <code>{order.mockSupplierOrderId}</code>}
          {order.stripeRefundId && <code>{order.stripeRefundId}</code>}
        </p>
      )}

      <details className="raw">
        <summary>CJ order payload preview (what approval would send once live purchasing is enabled — NOT sent)</summary>
        <pre>{JSON.stringify(previewSupplierOrderPayload(order), null, 2)}</pre>
      </details>

      {order.items.some((i) => i.checks.length) && (
        <>
          <h2>Live recheck history</h2>
          <table className="table small">
            <thead>
              <tr>
                <th>Checked</th>
                <th>CJ VID</th>
                <th>Price</th>
                <th>Inventory</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {order.items
                .flatMap((i) => i.checks)
                .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime())
                .map((c) => (
                  <tr key={c.id}>
                    <td>{fmtTime(c.checkedAt)}</td>
                    <td>
                      <code>{c.supplierVariantId}</code>
                    </td>
                    <td>{formatMoney(c.priceCents)}</td>
                    <td>{c.inventoryTotal ?? "—"}</td>
                    <td className={c.ok ? "ok-text" : "err-text"}>{c.ok ? "OK" : c.error}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
