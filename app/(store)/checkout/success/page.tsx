import Link from "next/link";
import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { markOrderPaidFromSession } from "@/lib/orders";
import { prisma } from "@/lib/db";
import ClearCart from "./ClearCart";

export const dynamic = "force-dynamic";

export default async function SuccessPage({ searchParams }: { searchParams: Promise<{ session_id?: string }> }) {
  const { session_id } = await searchParams;
  if (!session_id) redirect("/shop");
  const session = await stripe().checkout.sessions.retrieve(session_id);
  await markOrderPaidFromSession(session);
  const order = await prisma.order.findUnique({ where: { stripeSessionId: session.id } });
  if (!order) redirect("/shop");
  const paid = session.payment_status === "paid";
  return (
    <div className="wrap page narrow">
      {paid && <ClearCart />}
      <h1>{paid ? "Thank you — order received" : "Payment not completed"}</h1>
      <p>
        Order <strong>{order.number}</strong>
      </p>
      {paid ? (
        <p className="muted">We&apos;re reviewing your order and will email you when it ships.</p>
      ) : (
        <p className="muted">Your card was not charged. You can return to your cart and try again.</p>
      )}
      <p>
        <Link href={`/orders/${order.number}?s=${encodeURIComponent(session.id)}`}>View order details →</Link>
      </p>
    </div>
  );
}
