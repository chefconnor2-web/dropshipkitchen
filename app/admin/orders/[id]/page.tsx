import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { stockLabel, stockStatus } from "@/lib/inventory";
import { previewSupplierOrderPayload } from "@/lib/orders";
import { cjBalanceCents, supplierMode } from "@/lib/fulfillment";
import type { CjFreightOption } from "@/lib/cj/client";
import { Flash, Source, fmtTime } from "@/components/admin";
import {
  approveOrderAction,
  declineOrderAction,
  payCjOrderAction,
  placeCjOrderAction,
  quoteShippingAction,
  refreshCjOrderAction,
  refreshOrderCj,
} from "@/app/admin/actions";

type CostItem = { supplierPriceAtOrderCents: number | null; quantity: number };
const costKnown0 = (items: CostItem[]) => items.every((i) => i.supplierPriceAtOrderCents != null);
const itemsCost = (items: CostItem[]) => items.reduce((n, i) => n + (i.supplierPriceAtOrderCents ?? 0) * i.quantity, 0);

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
  const mode = supplierMode();
  const quote = JSON.parse(order.cjQuoteJson || "[]") as CjFreightOption[];
  const balance = mode === "live" && awaiting ? await cjBalanceCents() : null;
  const cheapestTotal = quote.length && costKnown0(order.items) ? itemsCost(order.items) + Math.round(quote[0].logisticPrice * 100) : null;
  const shipOption = (q: CjFreightOption, checked: boolean) => {
    const shipCents = Math.round(q.logisticPrice * 100);
    return (
      <label key={q.logisticName} className="ship-opt">
        <input type="radio" name="logisticName" value={q.logisticName} defaultChecked={checked} />
        <span className="strong">{q.logisticName}</span>
        <span>{formatMoney(shipCents)}</span>
        <span className="muted">{q.logisticAging ? `${q.logisticAging} days` : ""}</span>
        <span className="muted">≈ {costKnown0(order.items) ? formatMoney(itemsCost(order.items) + shipCents) : "?"} total from CJ</span>
      </label>
    );
  };

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
        <section className="card pad fulfil">
          <div className="row between">
            <h2 className="fulfil-title">Fulfil with CJ</h2>
            <span className={`pill pill-mode-${mode}`}>SUPPLIER_MODE={mode}</span>
          </div>
          {mode === "mock" ? (
            <p className="small">
              CJ orders are switched off. To place them from here, set <code>SUPPLIER_MODE</code> to <code>sandbox</code>{" "}
              (CJ test orders: no charge, no shipping) or <code>live</code> (also real orders paid from your CJ balance) in
              your hosting variables.
            </p>
          ) : (
            <>
              <div className="row gap">
                <form action={quoteShippingAction}>
                  <input type="hidden" name="orderId" value={order.id} />
                  <button className="btn">{quote.length ? "REFRESH SHIPPING QUOTE" : "1 · GET CJ SHIPPING QUOTE"}</button>
                </form>
                {order.cjFromCountry && <span className="small muted">Ships from {order.cjFromCountry} · live from CJ</span>}
                {mode === "live" && (
                  <span className="small">
                    CJ balance <strong>{balance == null ? "unavailable" : formatMoney(balance)}</strong>
                  </span>
                )}
              </div>
              {quote.length > 0 && (
                <form action={placeCjOrderAction} className="fulfil-form">
                  <input type="hidden" name="orderId" value={order.id} />
                  <fieldset>
                    <legend>2 · Shipping method</legend>
                    {quote.slice(0, 6).map((q, n) => shipOption(q, n === 0))}
                    {quote.length > 6 && (
                      <details>
                        <summary className="small">{quote.length - 6} more methods</summary>
                        {quote.slice(6).map((q) => shipOption(q, false))}
                      </details>
                    )}
                  </fieldset>
                  <div className="row gap">
                    <button className="btn" name="kind" value="sandbox">
                      3 · PLACE SANDBOX TEST ORDER
                    </button>
                    <span className="small muted">Simulated payment. Nothing is charged or shipped.</span>
                  </div>
                  {mode === "live" ? (
                    <div className="real-order">
                      {balance != null && cheapestTotal != null && balance < cheapestTotal && (
                        <p className="notice err small">
                          Your CJ balance ({formatMoney(balance)}) won’t cover this order. Top up your CJ wallet first, or the
                          order is created but left unpaid.
                        </p>
                      )}
                      <label className="confirm-real">
                        <input type="checkbox" name="confirmReal" value="yes" /> I understand this places a <b>real</b> CJ order
                        that ships to the customer and charges my CJ balance about{" "}
                        <b>{costKnown ? formatMoney(costAtOrder + Math.round(quote[0].logisticPrice * 100)) : "the quoted total"}</b>{" "}
                        (exact amount depends on the method chosen).
                      </label>
                      <button className="btn danger" name="kind" value="real">
                        3 · PLACE REAL ORDER &amp; PAY FROM CJ BALANCE
                      </button>
                    </div>
                  ) : (
                    <p className="small muted">Real orders are off in this environment (SUPPLIER_MODE=sandbox).</p>
                  )}
                </form>
              )}
            </>
          )}
          {order.cjError && <p className="notice err">{order.cjError}</p>}
          <div className="decision row gap">
            <form action={approveOrderAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <button className="btn">APPROVE WITHOUT CJ ORDER (mock)</button>
            </form>
            <form action={declineOrderAction} className="row gap">
              <input type="hidden" name="orderId" value={order.id} />
              <input name="note" placeholder="Reason (optional)" />
              <button className="btn danger">DECLINE &amp; REFUND</button>
            </form>
          </div>
        </section>
      )}

      {order.cjPlacedAt && (
        <section className="card pad fulfil">
          <div className="row between">
            <h2 className="fulfil-title">CJ order</h2>
            <span className={`pill ${order.cjSandbox ? "pill-mode-sandbox" : "pill-ok"}`}>{order.cjSandbox ? "SANDBOX — not charged, not shipped" : "REAL ORDER"}</span>
          </div>
          <dl className="kv">
            <dt>CJ order id</dt>
            <dd>
              <code>{order.cjOrderId ?? "—"}</code>
            </dd>
            <dt>Our order number at CJ</dt>
            <dd>
              <code>{order.cjOrderNumber}</code>
            </dd>
            <dt>Shipment order</dt>
            <dd>
              <code>{order.cjShipmentOrderId ?? "—"}</code>
            </dd>
            <dt>Shipping</dt>
            <dd>
              {order.cjLogisticName} from {order.cjFromCountry}
            </dd>
            <dt>CJ amount</dt>
            <dd>{formatMoney(order.cjAmountCents)}</dd>
            <dt>Paid to CJ</dt>
            <dd className={order.cjPaidAt ? "ok-text" : "err-text"}>{order.cjPaidAt ? fmtTime(order.cjPaidAt) : "Not paid yet"}</dd>
            <dt>CJ status</dt>
            <dd>{order.cjStatus ?? "—"}</dd>
            <dt>Tracking</dt>
            <dd>{order.cjTrackingNumber ? <code>{order.cjTrackingNumber}</code> : "Not shipped yet"}</dd>
          </dl>
          {order.cjError && <p className="notice err">{order.cjError}</p>}
          <div className="row gap">
            <form action={refreshCjOrderAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <button className="btn">REFRESH CJ STATUS</button>
            </form>
            {!order.cjPaidAt && (order.cjShipmentOrderId || order.cjOrderId) && (
              <form action={payCjOrderAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <button className="btn primary">RETRY PAYMENT</button>
              </form>
            )}
          </div>
        </section>
      )}

      {order.decisionNote && (
        <p className="notice">
          {order.decisionNote} {order.mockSupplierOrderId && <code>{order.mockSupplierOrderId}</code>}
          {order.stripeRefundId && <code>{order.stripeRefundId}</code>}
        </p>
      )}

      <details className="raw">
        <summary>CJ order payload preview (the address and items a CJ order is built from)</summary>
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
