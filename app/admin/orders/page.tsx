import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { fmtTime } from "@/components/admin";

export default async function OrdersPage() {
  const orders = await prisma.order.findMany({ orderBy: { createdAt: "desc" }, include: { items: true }, take: 200 });
  return (
    <>
      <h1>Orders</h1>
      <table className="table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Placed</th>
            <th>Customer</th>
            <th>Items</th>
            <th>Total</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>
                <Link href={`/admin/orders/${o.id}`}>{o.number}</Link>
              </td>
              <td className="small">{fmtTime(o.createdAt)}</td>
              <td className="small">{o.email ?? "—"}</td>
              <td className="small">{o.items.map((i) => `${i.quantity}× ${i.productTitle} (${i.variantName})`).join(", ")}</td>
              <td>{formatMoney(o.subtotalCents)}</td>
              <td>
                <span className={`pill pill-${o.status}`}>{o.status}</span>
              </td>
            </tr>
          ))}
          {orders.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No orders yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
