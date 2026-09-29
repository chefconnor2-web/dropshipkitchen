import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

const CUSTOMER_STATUS: Record<string, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  AWAITING_MERCHANT_APPROVAL: "Received — being reviewed",
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
      stripeSessionId: true,
      createdAt: true,
      items: { select: { id: true, productTitle: true, variantName: true, quantity: true, customerPriceCents: true } },
    },
  });
  // Possession of the Stripe session id acts as the view token for this proof.
  if (!order || !s || order.stripeSessionId !== s) notFound();
  return (
    <div className="narrow">
      <h1>Order {order.number}</h1>
      <p>
        Status: <strong>{CUSTOMER_STATUS[order.status] ?? order.status}</strong>
      </p>
      <table className="table">
        <tbody>
          {order.items.map((i) => (
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
      <p className="right">
        <strong>Total paid {formatMoney(order.subtotalCents)}</strong>
      </p>
    </div>
  );
}
