import { notFound } from "next/navigation";
import { after } from "next/server";
import Link from "next/link";
import { checkOrderViewToken, getMemberId } from "@/lib/session";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { STAGE_LABEL, trackingLinks, type TrackingStage } from "@/lib/carriers";
import { syncOrderTracking } from "@/lib/tracking";
import { countryLabel } from "@/lib/shipping";
import LocalTime from "@/components/store/LocalTime";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your order", robots: { index: false, follow: false } };

/** An open order page re-checks the carrier at most this often (the background sync covers the rest). */
const VIEW_REFRESH_MS = 20 * 60_000;

const STEPS = ["Ordered", "Confirmed", "Shipped", "In transit", "Out for delivery", "Delivered"] as const;
const STAGE_STEP: Record<TrackingStage, number> = { label: 2, in_transit: 3, out_for_delivery: 4, delivered: 5, exception: 2 };

function etaText(eta: string | null): string | null {
  if (!eta) return null;
  const m = eta.match(/^(\d+)\s*[-~–]\s*(\d+)$/);
  if (m) return `Usually ${m[1]}–${m[2]} days from shipping`;
  if (/^\d+$/.test(eta)) return `Usually about ${eta} days from shipping`;
  return `Estimated: ${eta}`;
}

function shipTo(json: string | null): string | null {
  try {
    const a = (JSON.parse(json || "null") as { address?: Record<string, string | null> } | null)?.address;
    if (!a) return null;
    return [a.city, a.state, a.country ? countryLabel(a.country) : null].filter(Boolean).join(", ") || null;
  } catch {
    return null;
  }
}

// Customer view: our product names, our prices, carrier tracking. No supplier fields reach the page.
export default async function CustomerOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ s?: string; t?: string }>;
}) {
  const { number } = await params;
  const { s, t } = await searchParams;
  const order = await prisma.order.findUnique({
    where: { number },
    select: {
      id: true,
      number: true,
      status: true,
      subtotalCents: true,
      shippingCents: true,
      cjTrackingNumber: true,
      cjLogisticName: true,
      customerShipMethod: true,
      stripeSessionId: true,
      customerId: true,
      createdAt: true,
      paidAt: true,
      decidedAt: true,
      cjPlacedAt: true,
      shippingAddressJson: true,
      trackingStage: true,
      trackingStatus: true,
      trackingEta: true,
      lastMileCarrier: true,
      lastMileNumber: true,
      shippedAt: true,
      deliveredAt: true,
      trackingCheckedAt: true,
      parcels: {
        orderBy: { index: "asc" },
        select: { index: true, cjTrackingNumber: true, trackingStage: true, trackingStatus: true, trackingEta: true, lastMileCarrier: true, lastMileNumber: true, deliveredAt: true },
      },
      trackingEvents: { orderBy: { at: "desc" }, take: 30, select: { id: true, stage: true, detail: true, parcelIndex: true, at: true } },
      items: { select: { id: true, productTitle: true, variantName: true, quantity: true, customerPriceCents: true, mysteryBoxName: true, mysteryBoxGroup: true, productId: true } },
    },
  });
  // Three ways in, all specific to this order: the signed link from our emails (t), the Stripe checkout
  // session id from the success page (s), or being signed in as the customer who placed it.
  const memberId = await getMemberId();
  const allowed =
    !!order &&
    ((!!s && order.stripeSessionId === s) || (!!memberId && order.customerId === memberId) || (await checkOrderViewToken(order.id, t)));
  if (!order || !allowed || order.status === "PENDING_PAYMENT") notFound();

  // Opening the page nudges a fresh carrier check (after the response, so the page never waits on CJ).
  if (
    order.status === "SUPPLIER_ORDER_PLACED" &&
    !order.deliveredAt &&
    (!order.trackingCheckedAt || Date.now() - order.trackingCheckedAt.getTime() > VIEW_REFRESH_MS)
  ) {
    after(() => syncOrderTracking(order.id).catch(() => null));
  }

  const cancelled = order.status === "DECLINED_REFUNDED" || order.status === "PAYMENT_FAILED";
  const stage = (order.trackingStage as TrackingStage | null) ?? (order.cjTrackingNumber ? "label" : null);
  const exception = stage === "exception";
  const confirmed = ["PLACING_SUPPLIER_ORDER", "SUPPLIER_ORDER_PLACED", "APPROVED_MOCK_FULFILLMENT"].includes(order.status);
  // The furthest step reached. A problem is shown on the step after the last good one.
  const lastGood = [...order.trackingEvents].find((e) => e.stage !== "exception")?.stage as TrackingStage | undefined;
  const reached = stage ? (exception ? (lastGood ? STAGE_STEP[lastGood] : 2) : STAGE_STEP[stage]) : confirmed ? 1 : 0;
  const firstAt = (st: string) => [...order.trackingEvents].reverse().find((e) => e.stage === st)?.at ?? null;
  const stepAt: (Date | null)[] = [
    order.paidAt ?? order.createdAt,
    order.cjPlacedAt ?? order.decidedAt,
    order.shippedAt,
    firstAt("in_transit"),
    firstAt("out_for_delivery"),
    order.deliveredAt,
  ];

  const split = order.cjLogisticName === "SPLIT" && order.parcels.length > 1;
  const headline = cancelled
    ? "Cancelled and refunded"
    : stage
      ? STAGE_LABEL[stage]
      : confirmed
        ? "Confirmed, being prepared"
        : "Received, being reviewed";
  const sub = cancelled
    ? "We couldn’t fulfil this order, so the full amount was refunded to your original payment method."
    : exception
      ? `The carrier reported: “${order.trackingStatus ?? "a delivery problem"}”. We’ve been alerted and will follow up. You can also reply to any of our emails.`
      : stage === "delivered"
        ? "The carrier reports this order as delivered."
        : stage
          ? order.trackingStatus && order.trackingStatus.toLowerCase() !== STAGE_LABEL[stage].toLowerCase()
            ? order.trackingStatus
            : stage === "label"
              ? "Handed to the carrier. The first scan can take a day or two to appear."
              : stage === "in_transit"
                ? "Moving through the carrier network toward you."
                : "With the local courier today."
          : confirmed && order.customerShipMethod === "SEA"
            ? "Booked to sail from our China warehouse to Canada, about 4–7 weeks door to door. You’ll get an email with tracking once it’s on its way."
            : confirmed
            ? "Your order is with our warehouse. You’ll get an email with tracking the moment it ships."
            : "We’re checking your order. You’ll get an email as soon as it’s confirmed.";
  const eta = stage && stage !== "delivered" && !exception ? etaText(order.trackingEta ?? order.parcels.find((p) => p.trackingEta)?.trackingEta ?? null) : null;
  const where = shipTo(order.shippingAddressJson);

  const parcels = split
    ? order.parcels.map((p) => ({
        title: `Parcel ${p.index + 1} of ${order.parcels.length}`,
        stage: (p.trackingStage as TrackingStage | null) ?? (p.cjTrackingNumber ? "label" : null),
        status: p.trackingStatus,
        links: trackingLinks({ number: p.cjTrackingNumber, lastMileCarrier: p.lastMileCarrier, lastMileNumber: p.lastMileNumber }),
      }))
    : order.cjTrackingNumber
      ? [{ title: "Your parcel", stage, status: null, links: trackingLinks({ number: order.cjTrackingNumber, lastMileCarrier: order.lastMileCarrier, lastMileNumber: order.lastMileNumber }) }]
      : [];

  return (
    <div className="wrap page narrow trk">
      <p className="eyebrow">Order {order.number}</p>
      <h1 className="page-title">Track your order</h1>

      <section className={`trk-hero${exception ? " is-warn" : stage === "delivered" ? " is-done" : cancelled ? " is-off" : ""}`} aria-live="polite">
        <div className="trk-headline">{headline}</div>
        <p className="trk-sub">{sub}</p>
        {eta && <p className="trk-eta">{eta}</p>}
        {where && <p className="trk-where">Shipping to {where}</p>}
      </section>

      {!cancelled && (
        <ol className="trk-steps" aria-label="Order progress">
          {STEPS.map((label, i) => {
            const done = i <= reached;
            const warn = exception && i === reached + 1;
            const at = stepAt[i];
            return (
              <li key={label} className={`${done ? "done" : ""}${i === reached ? " current" : ""}${warn ? " warn" : ""}`} aria-current={i === reached ? "step" : undefined}>
                <span className="trk-dot" aria-hidden />
                <span className="trk-step-label">{warn ? "Needs attention" : label}</span>
                {done && at && (
                  <span className="trk-step-at">
                    <LocalTime iso={at.toISOString()} withTime={false} />
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {parcels.length > 0 && (
        <section className="trk-parcels">
          {parcels.map((p) => (
            <div key={p.title} className="trk-parcel">
              <div className="trk-parcel-head">
                <strong>{p.title}</strong>
                {split && <span className={`trk-chip trk-chip-${p.stage ?? "waiting"}`}>{p.stage ? STAGE_LABEL[p.stage] : "Not shipped yet"}</span>}
              </div>
              {split && p.status && <p className="muted small trk-parcel-status">{p.status}</p>}
              {p.links.length > 0 ? (
                <>
                  <p className="trk-number">
                    Tracking number <code>{p.links[p.links.length - 1].number}</code>
                    {p.links.length > 1 && p.links[0].number !== p.links[p.links.length - 1].number && (
                      <>
                        <br />
                        {p.links[0].label.replace(/^Track (on|with) /, "")} number <code>{p.links[0].number}</code>
                      </>
                    )}
                  </p>
                  <div className="trk-links">
                    {p.links.map((l, i) => (
                      <a key={l.href} className={`btn${i === 0 ? " primary" : ""}`} href={l.href} target="_blank" rel="noreferrer">
                        {l.label} ↗
                      </a>
                    ))}
                  </div>
                </>
              ) : (
                <p className="muted small">Tracking appears here when this parcel ships.</p>
              )}
            </div>
          ))}
          <p className="muted small trk-checked">
            {order.trackingCheckedAt ? (
              <>
                Last checked with the carrier: <LocalTime iso={order.trackingCheckedAt.toISOString()} />
                {stage !== "delivered" && <> · We re-check automatically and email you when it’s delivered</>}
              </>
            ) : (
              "We check with the carrier automatically and email you when it’s delivered."
            )}
          </p>
        </section>
      )}

      {order.trackingEvents.length > 0 && (
        <section className="trk-updates">
          <h2>Updates</h2>
          <ul>
            {order.trackingEvents.map((e) => (
              <li key={e.id} className={e.stage === "exception" ? "warn" : ""}>
                <span className="trk-up-at">
                  <LocalTime iso={e.at.toISOString()} />
                </span>
                <span>
                  <strong>{STAGE_LABEL[e.stage as TrackingStage] ?? e.stage}</strong>
                  {split && e.parcelIndex != null ? <span className="muted"> · parcel {e.parcelIndex + 1}</span> : null}
                  {e.detail && e.detail !== STAGE_LABEL[e.stage as TrackingStage] ? <span className="muted"> · {e.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2>What’s in it</h2>
      {[...new Set(order.items.filter((i) => i.mysteryBoxGroup).map((i) => i.mysteryBoxGroup!))].map((g) => {
        const inBox = order.items.filter((i) => i.mysteryBoxGroup === g);
        return (
          <section key={g} className="box-reveal">
            <p className="eyebrow">Revealed</p>
            <h2>Your {inBox[0].mysteryBoxName} contains</h2>
            <ul>
              {inBox.map((i) => (
                <li key={i.id}>
                  <strong>{i.productTitle}</strong>
                  {i.variantName && !/^default$/i.test(i.variantName) ? <span className="muted"> · {i.variantName}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <table className="table">
        <tbody>
          {order.items.filter((i) => !i.mysteryBoxGroup).map((i) => (
            <tr key={i.id}>
              <td>
                {i.productTitle}
                <div className="muted small">{i.variantName}</div>
              </td>
              <td>× {i.quantity}</td>
              <td>{formatMoney(i.customerPriceCents * i.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {[...new Set(order.items.filter((i) => i.mysteryBoxGroup).map((i) => i.mysteryBoxGroup!))].map((g) => {
        const inBox = order.items.filter((i) => i.mysteryBoxGroup === g);
        return (
          <p key={g} className="right">
            Mystery box: {inBox[0].mysteryBoxName} {formatMoney(inBox.reduce((n, i) => n + i.customerPriceCents * i.quantity, 0))}
          </p>
        );
      })}
      <p className="right">
        Shipping {order.shippingCents ? formatMoney(order.shippingCents) : "Free"}
        <br />
        <strong>Total paid {formatMoney(order.subtotalCents + order.shippingCents)}</strong>
      </p>
      <p className="muted small trk-help">
        Questions about this order? Reply to any email we sent you. Placed <LocalTime iso={order.createdAt.toISOString()} withTime={false} />.{" "}
        <Link href="/track">Track another order</Link>
      </p>
    </div>
  );
}
