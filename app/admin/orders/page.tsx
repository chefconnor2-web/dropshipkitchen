import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Flash, StatusChip, timeAgo } from "@/components/admin";
import { STAGE_LABEL, type TrackingStage } from "@/lib/carriers";
import { syncAllTrackingAction } from "../actions";

const FILTERS: Record<"action" | "placed" | "closed" | "all", { label: string; where: Prisma.OrderWhereInput }> = {
  action: { label: "Needs approval", where: { status: "AWAITING_MERCHANT_APPROVAL" } },
  placed: { label: "Sent to CJ", where: { status: { in: ["SUPPLIER_ORDER_PLACED", "PLACING_SUPPLIER_ORDER", "APPROVED_MOCK_FULFILLMENT"] } } },
  closed: { label: "Declined", where: { status: { in: ["DECLINED_REFUNDED", "PAYMENT_FAILED"] } } },
  all: { label: "All", where: { status: { not: "PENDING_PAYMENT" } } },
};
type FilterKey = keyof typeof FILTERS;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ show?: string; notice?: string }> }) {
  const { show, notice } = await searchParams;
  const counts = Object.fromEntries(
    await Promise.all((Object.keys(FILTERS) as FilterKey[]).map(async (k) => [k, await prisma.order.count({ where: FILTERS[k].where })])),
  ) as Record<FilterKey, number>;
  // Open on the queue that needs you; fall back to everything when it's empty.
  const filter: FilterKey = show && show in FILTERS ? (show as FilterKey) : counts.action > 0 ? "action" : "all";

  const orders = await prisma.order.findMany({
    where: FILTERS[filter].where,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { items: true },
  });
  const variantIds = orders.flatMap((o) => o.items.map((i) => i.productVariantId)).filter((x): x is string => !!x);
  const productIds = orders.flatMap((o) => o.items.map((i) => i.productId)).filter((x): x is string => !!x);
  const [variants, images] = await Promise.all([
    prisma.productVariant.findMany({ where: { id: { in: variantIds } }, select: { id: true, imageUrl: true } }),
    prisma.productImage.findMany({ where: { productId: { in: productIds }, position: 0 }, select: { id: true, productId: true } }),
  ]);
  const variantImg = new Set(variants.filter((v) => v.imageUrl).map((v) => v.id));
  const productImg = new Map(images.map((i) => [i.productId, i.id]));
  const thumb = (i: { productVariantId: string | null; productId: string | null }) =>
    i.productVariantId && variantImg.has(i.productVariantId)
      ? `/media/v/${i.productVariantId}`
      : i.productId && productImg.has(i.productId)
        ? `/media/${productImg.get(i.productId)}`
        : null;

  return (
    <>
      <div className="a-head">
        <h1>Orders</h1>
        <form action={syncAllTrackingAction}>
          <button className="a-btn a-btn-sm">Check all tracking now</button>
        </form>
      </div>
      <Flash notice={notice} />
      <div className="seg-tabs" role="tablist" aria-label="Filter orders">
        {(Object.keys(FILTERS) as FilterKey[]).map((k) => (
          <Link key={k} href={`/admin/orders?show=${k}`} role="tab" aria-selected={k === filter} className={k === filter ? "on" : ""}>
            {FILTERS[k].label}
            <span className="seg-count">{counts[k]}</span>
          </Link>
        ))}
      </div>

      {orders.length === 0 ? (
        <div className="a-empty">
          <p className="a-empty-title">{filter === "action" ? "You’re all caught up." : "No orders here yet."}</p>
          <p className="muted small">New paid orders show up under Needs approval.</p>
        </div>
      ) : (
        <ul className="order-list">
          {orders.map((o) => {
            const first = o.items[0];
            const src = first ? thumb(first) : null;
            const units = o.items.reduce((n, i) => n + i.quantity, 0);
            return (
              <li key={o.id}>
                <Link href={`/admin/orders/${o.id}`} className="order-card">
                  <div className="order-thumb">{src ? <img src={src} alt="" loading="lazy" /> : <span />}</div>
                  <div className="order-main">
                    <div className="order-line1">
                      <span className="order-who">{o.customerName || o.email || "Customer"}</span>
                      <span className="order-total">{formatMoney(o.subtotalCents)}</span>
                    </div>
                    <div className="order-items">
                      {first ? `${first.productTitle}${first.variantName && !/^default$/i.test(first.variantName) ? ` · ${first.variantName}` : ""}` : "—"}
                      {o.items.length > 1 ? ` + ${o.items.length - 1} more` : ""}
                    </div>
                    <div className="order-line3">
                      <StatusChip status={o.status} sandbox={o.cjSandbox} />
                      {o.trackingStage && <span className={`chip-status ${o.trackingStage === "exception" ? "tone-bad" : o.trackingStage === "delivered" ? "tone-good" : "tone-busy"}`}>{STAGE_LABEL[o.trackingStage as TrackingStage]}</span>}
                      <span className="muted">
                        {units} item{units === 1 ? "" : "s"} · {timeAgo(o.paidAt ?? o.createdAt)} · {o.number}
                      </span>
                    </div>
                  </div>
                  <span className="chev" aria-hidden>
                    ›
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
