import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { trackingUrl } from "@/lib/order-emails";

export const dynamic = "force-dynamic";

const CUSTOMER_STATUS: Record<string, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  AWAITING_MERCHANT_APPROVAL: "Received — being reviewed",
  PLACING_SUPPLIER_ORDER: "Confirmed — preparing for shipment",
  SUPPLIER_ORDER_PLACED: "Confirmed — preparing for shipment",
  APPROVED_MOCK_FULFILLMENT: "Confirmed — preparing for shipment",
  DECLINED_REFUNDED: "Cancelled — refunded",
};

// Customer view: our product names, our prices, status. No supplier fields are selected at all.
export default async function CustomerOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ s?: string }>;
}) {
  const { number } = await params;
  const { s } = await searchParams;
  const order = await prisma.order.findUnique({
    where: { number },
    select: {
      number: true,
      status: true,
      subtotalCents: true,
      shippingCents: true,
      cjTrackingNumber: true,
      stripeSessionId: true,
      createdAt: true,
      items: { select: { id: true, productTitle: true, variantName: true, quantity: true, customerPriceCents: true, mysteryBoxName: true, mysteryBoxGroup: true, productId: true } },
    },
  });
  // Possession of the Stripe session id acts as the view token for this proof.
  if (!order || !s || order.stripeSessionId !== s) notFound();
  return (
    <div className="wrap page narrow">
      <h1>Order {order.number}</h1>
      <p>
        Status: <strong>{order.cjTrackingNumber ? "Shipped" : (CUSTOMER_STATUS[order.status] ?? order.status)}</strong>
      </p>
      {order.cjTrackingNumber && (
        <p>
          Tracking: <code>{order.cjTrackingNumber}</code>{" "}
          <a href={trackingUrl(order.cjTrackingNumber)} target="_blank" rel="noreferrer">
            Track package →
          </a>
        </p>
      )}
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
    </div>
  );
}
