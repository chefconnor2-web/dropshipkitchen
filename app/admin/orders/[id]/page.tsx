import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { stockLabel, stockStatus } from "@/lib/inventory";
import { previewSupplierOrderPayload } from "@/lib/orders";
import { cjBalanceCents, quoteShipping, supplierMode } from "@/lib/fulfillment";
import type { CjFreightOption } from "@/lib/cj/client";
import { Flash, StatusChip, fmtTime, timeAgo } from "@/components/admin";
import {
  approveOrderAction,
  declineOrderAction,
  payCjOrderAction,
  placeCjOrderAction,
  quoteShippingAction,
  refreshCjOrderAction,
  refreshOrderCj,
  resendOrderEmailAction,
} from "@/app/admin/actions";

/** Upper bound of a CJ delivery window like "5-11", for picking the fastest method. */
function maxDays(aging?: string) {
  const n = (aging ?? "").match(/\d+/g)?.map(Number) ?? [];
  return n.length ? Math.max(...n) : Number.POSITIVE_INFINITY;
}

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

  const [svs, variants, images, emails] = await Promise.all([
    prisma.cjSupplierVariant.findMany({ where: { cjVariantId: { in: order.items.map((i) => i.supplierVariantId) } } }),
    prisma.productVariant.findMany({
      where: { id: { in: order.items.map((i) => i.productVariantId).filter((x): x is string => !!x) } },
      select: { id: true, imageUrl: true },
    }),
    prisma.productImage.findMany({
      where: { productId: { in: order.items.map((i) => i.productId).filter((x): x is string => !!x) }, position: 0 },
      select: { id: true, productId: true },
    }),
    prisma.emailLog.findMany({ where: { orderId: id }, orderBy: { createdAt: "desc" } }),
  ]);
  const svByVid = new Map(svs.map((s) => [s.cjVariantId, s]));
  const variantImg = new Set(variants.filter((v) => v.imageUrl).map((v) => v.id));
  const productImg = new Map(images.map((i) => [i.productId, i.id]));

  const ship = order.shippingAddressJson ? JSON.parse(order.shippingAddressJson) : null;
  const addr = ship?.address ?? {};
  const awaiting = order.status === "AWAITING_MERCHANT_APPROVAL";
  const mode = supplierMode();
  let quote = JSON.parse(order.cjQuoteJson || "[]") as CjFreightOption[];
  let autoQuoteError: string | null = null;
  // Opening an order that needs approval fetches its shipping quote, so the next tap is choosing a method.
  if (awaiting && mode !== "mock" && quote.length === 0 && ship?.address?.country) {
    try {
      quote = await quoteShipping(order.id);
    } catch (e) {
      autoQuoteError = e instanceof Error ? e.message : String(e);
    }
  }
  const balance = mode === "live" && awaiting ? await cjBalanceCents() : null;

  const costKnown = order.items.every((i) => i.supplierPriceAtOrderCents != null);
  const productCost = order.items.reduce((n, i) => n + (i.supplierPriceAtOrderCents ?? 0) * i.quantity, 0);
  // Preselect the method the customer paid for; fall back to CJ's cheapest.
  const chosen = quote.find((q) => q.logisticName === order.customerShipMethod) ?? quote[0];
  const shipCost = order.cjAmountCents != null ? order.cjAmountCents - productCost : chosen ? Math.round(chosen.logisticPrice * 100) : null;
  const cjTotal = order.cjAmountCents ?? (costKnown && shipCost != null ? productCost + shipCost : null);
  const paidTotal = order.subtotalCents + order.shippingCents;
  const profit = cjTotal != null ? paidTotal - cjTotal : costKnown ? order.subtotalCents - productCost : null;

  const cheapest = quote[0]?.logisticName;
  const fastest = quote.length ? [...quote].sort((a, b) => maxDays(a.logisticAging) - maxDays(b.logisticAging) || a.logisticPrice - b.logisticPrice)[0].logisticName : null;
  const shipOption = (q: CjFreightOption, checked: boolean) => {
    const cents = Math.round(q.logisticPrice * 100);
    return (
      <label key={q.logisticName} className="ship-card">
        <input type="radio" name="logisticName" value={q.logisticName} defaultChecked={checked} />
        <span className="ship-card-body">
          <span className="ship-card-top">
            <span className="ship-name">{q.logisticName}</span>
            <span className="ship-price">{formatMoney(cents)}</span>
          </span>
          <span className="ship-card-sub">
            <span>{q.logisticAging ? `${q.logisticAging} days` : "Delivery time not given"}</span>
            {q.logisticName === cheapest && <span className="tag tag-good">Cheapest</span>}
            {q.logisticName === fastest && <span className="tag tag-fast">Fastest</span>}
            {q.logisticName === order.customerShipMethod && <span className="tag">Customer paid for this</span>}
            <span className="ship-total">{costKnown ? `${formatMoney(productCost + cents)} from CJ` : ""}</span>
          </span>
        </span>
      </label>
    );
  };

  return (
    <>
      <Link href="/admin/orders" className="a-back">
        ‹ Orders
      </Link>
      <div className="a-head">
        <div>
          <h1>
            {order.customerId ? (
              <Link href={`/admin/customers/${order.customerId}`} className="h1-link">
                {order.customerName || order.email || "Order"}
              </Link>
            ) : (
              order.customerName || order.email || "Order"
            )}
          </h1>
          <div className="a-sub">
            <code>{order.number}</code> · paid {timeAgo(order.paidAt ?? order.createdAt)}
          </div>
        </div>
        <StatusChip status={order.status} sandbox={order.cjSandbox} />
      </div>
      <Flash notice={notice} error={error} />

      <section className="a-card money-row" aria-label="Money">
        <div>
          <div className="k">Customer paid</div>
          <div className="v">{formatMoney(paidTotal)}</div>
          {order.shippingCents > 0 && <div className="k">incl. {formatMoney(order.shippingCents)} shipping</div>}
        </div>
        <div>
          <div className="k">{order.cjAmountCents != null ? "CJ charged" : chosen ? (chosen.logisticName === order.customerShipMethod ? "CJ cost (their shipping)" : "CJ cost (cheapest)") : "CJ products"}</div>
          <div className="v">{cjTotal != null ? formatMoney(cjTotal) : costKnown ? formatMoney(productCost) : "—"}</div>
        </div>
        <div>
          <div className="k">{cjTotal != null ? "Profit" : "Profit before shipping"}</div>
          <div className={`v ${profit != null && profit < 0 ? "neg" : "pos"}`}>{profit != null ? formatMoney(profit) : "—"}</div>
        </div>
      </section>

      <section className="a-card">
        <h2 className="a-h2">Ship to</h2>
        {ship ? (
          <address className="ship-to">
            <strong>{ship.name}</strong>
            <br />
            {addr.line1}
            {addr.line2 ? (
              <>
                <br />
                {addr.line2}
              </>
            ) : null}
            <br />
            {[addr.city, addr.state, addr.postal_code].filter(Boolean).join(", ")} · {addr.country}
          </address>
        ) : (
          <p className="muted small">No shipping address on this order.</p>
        )}
        <div className="contact-row">
          {order.email && (
            <a className="pill-btn" href={`mailto:${order.email}`}>
              ✉ {order.email}
            </a>
          )}
          {order.customerPhone && (
            <a className="pill-btn" href={`tel:${order.customerPhone}`}>
              ☎ {order.customerPhone}
            </a>
          )}
        </div>
      </section>

      <section className="a-card">
        <h2 className="a-h2">Items</h2>
        <ul className="item-list">
          {order.items.map((i) => {
            const sv = svByVid.get(i.supplierVariantId);
            const last = i.checks[0];
            const inv = last?.ok ? last.inventoryTotal : sv?.inventoryTotal ?? null;
            const src =
              i.productVariantId && variantImg.has(i.productVariantId)
                ? `/media/v/${i.productVariantId}`
                : i.productId && productImg.has(i.productId)
                  ? `/media/${productImg.get(i.productId)}`
                  : null;
            return (
              <li key={i.id} className="item-row">
                <div className="order-thumb">{src ? <img src={src} alt="" loading="lazy" /> : <span />}</div>
                <div className="item-main">
                  <div className="item-title">{i.productTitle}</div>
                  <div className="muted small">
                    {!/^default$/i.test(i.variantName) && `${i.variantName} · `}
                    {i.quantity} × {formatMoney(i.customerPriceCents)}
                  </div>
                  <div className="small">
                    CJ {formatMoney(i.supplierPriceAtOrderCents)} each ·{" "}
                    <span className={`stock stock-${stockStatus(inv)}`}>{stockLabel(stockStatus(inv))}</span>
                  </div>
                </div>
                <div className="item-amt">{formatMoney(i.customerPriceCents * i.quantity)}</div>
              </li>
            );
          })}
        </ul>
      </section>

      {awaiting && (
        <section className="a-card fulfil" aria-label="Fulfil this order">
          <div className="a-card-head">
            <h2 className="a-h2">Fulfil with CJ</h2>
            {mode === "live" && (
              <span className="small">
                CJ balance <strong>{balance == null ? "—" : formatMoney(balance)}</strong>
              </span>
            )}
          </div>
          {mode === "mock" ? (
            <p className="small muted">
              CJ orders are switched off here. Set <code>SUPPLIER_MODE</code> to <code>sandbox</code> or <code>live</code> in your
              hosting variables to send orders to CJ.
            </p>
          ) : (
            <>
              <div className="step">
                <span className="step-n">1</span>
                <form action={quoteShippingAction} className="grow">
                  <input type="hidden" name="orderId" value={order.id} />
                  <button className="a-btn">{quote.length ? "Refresh shipping quote" : "Get CJ shipping quote"}</button>
                </form>
              </div>
              {quote.length > 0 && (
                <form action={placeCjOrderAction} className="fulfil-form">
                  <input type="hidden" name="orderId" value={order.id} />
                  <div className="step step-top">
                    <span className="step-n">2</span>
                    <fieldset className="grow">
                      <legend className="step-label">
                        Choose shipping <span className="muted">· from {order.cjFromCountry ?? "CN"}</span>
                      </legend>
                      <div className="ship-list">
                        {quote.slice(0, 5).map((q) => shipOption(q, q.logisticName === chosen?.logisticName))}
                        {quote.length > 5 && (
                          <details className="more">
                            <summary>{quote.length - 5} more shipping methods</summary>
                            <div className="ship-list">{quote.slice(5).map((q) => shipOption(q, q.logisticName === chosen?.logisticName))}</div>
                          </details>
                        )}
                      </div>
                    </fieldset>
                  </div>
                  <div className="step step-top">
                    <span className="step-n">3</span>
                    <div className="grow place">
                      {mode === "live" && (
                        <div className="real-box">
                          {balance != null && cjTotal != null && balance < cjTotal && (
                            <p className="warn-line">
                              Your CJ balance ({formatMoney(balance)}) won’t cover this order. Top up your CJ wallet first.
                            </p>
                          )}
                          <label className="confirm-real">
                            <input type="checkbox" name="confirmReal" value="yes" />
                            <span>
                              Place a <b>real</b> order: CJ ships to {ship?.name ?? "the customer"} and charges my CJ balance about{" "}
                              <b>{cjTotal != null ? formatMoney(cjTotal) : "the quoted total"}</b>.
                            </span>
                          </label>
                          <button className="a-btn a-btn-primary" name="kind" value="real">
                            Place real order
                          </button>
                        </div>
                      )}
                      <button className="a-btn" name="kind" value="sandbox">
                        Place sandbox test order
                      </button>
                      <p className="hint">Sandbox orders use CJ’s simulated payment: nothing is charged or shipped.</p>
                    </div>
                  </div>
                </form>
              )}
            </>
          )}
          {autoQuoteError && <p className="notice err">Couldn’t get a shipping quote from CJ: {autoQuoteError}</p>}
          {order.cjError && <p className="notice err">{order.cjError}</p>}
          <div className="other-actions">
            <form action={approveOrderAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <button className="a-btn a-btn-ghost">Approve without a CJ order</button>
            </form>
            <details className="decline">
              <summary className="a-btn a-btn-ghost danger-text">Decline &amp; refund…</summary>
              <form action={declineOrderAction} className="decline-form">
                <input type="hidden" name="orderId" value={order.id} />
                <label>
                  Reason (optional, for your records)
                  <input name="note" placeholder="e.g. out of stock at CJ" />
                </label>
                <button className="a-btn a-btn-danger">Refund {formatMoney(order.subtotalCents + order.shippingCents)} and decline</button>
              </form>
            </details>
          </div>
        </section>
      )}

      {order.cjPlacedAt && (
        <section className="a-card">
          <div className="a-card-head">
            <h2 className="a-h2">CJ order</h2>
            <span className={`chip-status ${order.cjSandbox ? "tone-busy" : "tone-good"}`}>{order.cjSandbox ? "Sandbox · not shipped" : "Real order"}</span>
          </div>
          <dl className="facts">
            <dt>Paid to CJ</dt>
            <dd className={order.cjPaidAt ? "ok-text" : "err-text"}>{order.cjPaidAt ? `${formatMoney(order.cjAmountCents)} · ${timeAgo(order.cjPaidAt)}` : "Not paid yet"}</dd>
            <dt>CJ status</dt>
            <dd>{order.cjStatus ?? "—"}</dd>
            <dt>Tracking</dt>
            <dd>{order.cjTrackingNumber ? <code>{order.cjTrackingNumber}</code> : "Not shipped yet"}</dd>
            <dt>Shipping</dt>
            <dd>
              {order.cjLogisticName} · from {order.cjFromCountry}
            </dd>
            <dt>CJ order</dt>
            <dd>
              <code>{order.cjOrderId ?? "—"}</code>
            </dd>
          </dl>
          {order.cjError && <p className="notice err">{order.cjError}</p>}
          <div className="btn-row">
            <form action={refreshCjOrderAction} className="grow">
              <input type="hidden" name="orderId" value={order.id} />
              <button className="a-btn">Refresh CJ status</button>
            </form>
            {!order.cjPaidAt && (order.cjShipmentOrderId || order.cjOrderId) && (
              <form action={payCjOrderAction} className="grow">
                <input type="hidden" name="orderId" value={order.id} />
                <button className="a-btn a-btn-primary">Retry payment</button>
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

      <section className="a-card">
        <h2 className="a-h2">Emails to {order.email || "the customer"}</h2>
        {emails.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <ul className="mini-list">
            {emails.map((e) => (
              <li key={e.id}>
                <div className="mini-row">
                  <span className="email-row-top">
                    <span className="strong">{e.subject}</span>
                    <span className={`chip-status ${e.status === "sent" ? "tone-good" : e.status === "failed" ? "tone-bad" : "tone-warn"}`}>
                      {e.status === "sent" ? "Sent" : e.status === "failed" ? "Failed" : "Not sent"}
                    </span>
                  </span>
                  <span className="muted small">
                    {e.to} · {timeAgo(e.createdAt)} ·{" "}
                    <a href={`/admin/emails/${e.id}`} target="_blank" rel="noreferrer">
                      Preview
                    </a>
                  </span>
                  {e.error && e.status !== "sent" && <span className="small muted">{e.error}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {order.email && (
          <div className="email-list-actions">
            <form action={resendOrderEmailAction}>
              <input type="hidden" name="id" value={order.id} />
              <input type="hidden" name="kind" value="order_confirmation" />
              <button className="a-btn a-btn-sm">Resend confirmation</button>
            </form>
            {order.cjTrackingNumber && (
              <form action={resendOrderEmailAction}>
                <input type="hidden" name="id" value={order.id} />
                <input type="hidden" name="kind" value="order_shipped" />
                <button className="a-btn a-btn-sm">Resend tracking</button>
              </form>
            )}
          </div>
        )}
      </section>

      <details className="a-card a-details">
        <summary>Supplier details &amp; history</summary>
        <div className="a-details-body">
          <form action={refreshOrderCj}>
            <input type="hidden" name="orderId" value={order.id} />
            <button className="a-btn">Re-check CJ price &amp; stock</button>
          </form>
          {order.items.map((i) => {
            const sv = svByVid.get(i.supplierVariantId);
            const last = i.checks[0];
            const curPrice = last?.ok ? last.priceCents : sv?.supplierPriceCents ?? null;
            const curInv = last?.ok ? last.inventoryTotal : sv?.inventoryTotal ?? null;
            return (
              <dl key={i.id} className="facts">
                <dt>Product</dt>
                <dd>{i.productTitle}</dd>
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
                <dt>Our SKU</dt>
                <dd>
                  <code>{i.internalSku}</code>
                </dd>
                <dt>CJ price</dt>
                <dd>
                  {formatMoney(i.supplierPriceAtOrderCents)} at order → {formatMoney(curPrice)} now
                  {curPrice != null && i.supplierPriceAtOrderCents != null && curPrice !== i.supplierPriceAtOrderCents && <span className="err-text"> (changed)</span>}
                </dd>
                <dt>CJ stock</dt>
                <dd>
                  {i.supplierInventoryAtOrder ?? "?"} at order → {curInv ?? "?"} now
                </dd>
                <dt>Checked</dt>
                <dd className="muted">{last ? `${fmtTime(last.checkedAt)}${last.ok ? "" : ` — failed: ${last.error}`}` : `cached ${fmtTime(sv?.inventoryCheckedAt)}`}</dd>
              </dl>
            );
          })}
          <p className="small muted">
            Placed {fmtTime(order.createdAt)} · paid {fmtTime(order.paidAt)}
            {order.stripePaymentIntent && (
              <>
                {" "}
                · Stripe <code>{order.stripePaymentIntent}</code>
              </>
            )}
          </p>
          <details>
            <summary className="small">CJ order request (address &amp; items sent to CJ)</summary>
            <pre className="wrap-pre">{JSON.stringify(previewSupplierOrderPayload(order), null, 2)}</pre>
          </details>
        </div>
      </details>
    </>
  );
}
