import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { stripe } from "@/lib/stripe";
import { refreshLive } from "@/lib/inventory";
import type Stripe from "stripe";

export const ORDER_STATUS = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  AWAITING_MERCHANT_APPROVAL: "AWAITING_MERCHANT_APPROVAL",
  APPROVED_MOCK_FULFILLMENT: "APPROVED_MOCK_FULFILLMENT",
  DECLINED_REFUNDED: "DECLINED_REFUNDED",
} as const;

export function newOrderNumber(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `CS-${ymd}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

/** Idempotently mark an order paid from a completed Stripe Checkout Session. */
export async function markOrderPaidFromSession(session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.orderId;
  if (!orderId || session.payment_status !== "paid") return null;
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== ORDER_STATUS.PENDING_PAYMENT) return order;

  const shipping =
    (session as unknown as { collected_information?: { shipping_details?: unknown } }).collected_information
      ?.shipping_details ?? (session as unknown as { shipping_details?: unknown }).shipping_details ?? null;
  return prisma.order.update({
    where: { id: order.id },
    data: {
      status: ORDER_STATUS.AWAITING_MERCHANT_APPROVAL,
      paidAt: new Date(),
      email: session.customer_details?.email ?? null,
      customerName: session.customer_details?.name ?? null,
      shippingAddressJson: shipping ? JSON.stringify(shipping) : null,
      stripePaymentIntent: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
    },
  });
}

/** Live re-query of CJ using the exact VID stored on each order item; every check is recorded. */
export async function recheckOrderSupplierData(orderId: string) {
  const items = await prisma.orderItem.findMany({ where: { orderId } });
  for (const item of items) {
    const sv = await prisma.cjSupplierVariant.findUnique({ where: { cjVariantId: item.supplierVariantId } });
    try {
      if (!sv) throw new Error(`Supplier variant ${item.supplierVariantId} is no longer in our catalog cache.`);
      const u = await refreshLive(sv.id);
      await prisma.supplierCheck.create({
        data: {
          orderItemId: item.id,
          supplierVariantId: item.supplierVariantId,
          priceCents: u.supplierPriceCents,
          inventoryTotal: u.inventoryTotal,
          ok: true,
        },
      });
    } catch (e) {
      await prisma.supplierCheck.create({
        data: {
          orderItemId: item.id,
          supplierVariantId: item.supplierVariantId,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }
}

/** The CJ order payload we WOULD send. Built for review only; never transmitted in this build. */
export function previewSupplierOrderPayload(order: {
  number: string;
  shippingAddressJson: string | null;
  customerName: string | null;
  items: Array<{ supplierVariantId: string; quantity: number }>;
}) {
  const ship = order.shippingAddressJson ? JSON.parse(order.shippingAddressJson) : null;
  const addr = ship?.address ?? {};
  return {
    endpoint: "POST /shopping/order/createOrderV2 (NOT CALLED — SUPPLIER_MODE=mock)",
    orderNumber: order.number,
    shippingCountryCode: addr.country ?? null,
    shippingProvince: addr.state ?? null,
    shippingCity: addr.city ?? null,
    shippingAddress: [addr.line1, addr.line2].filter(Boolean).join(", ") || null,
    shippingZip: addr.postal_code ?? null,
    shippingCustomerName: ship?.name ?? order.customerName,
    products: order.items.map((i) => ({ vid: i.supplierVariantId, quantity: i.quantity })),
  };
}

export async function approveOrder(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  if (order.status !== ORDER_STATUS.AWAITING_MERCHANT_APPROVAL)
    throw new Error(`Order is ${order.status}; only AWAITING_MERCHANT_APPROVAL orders can be approved.`);
  if (config.supplierMode !== "mock")
    throw new Error("Live CJ purchasing is disabled in this build. Set SUPPLIER_MODE=mock.");
  // SUPPLIER_MODE=mock: record the decision and a mock supplier reference. No CJ order is created.
  return prisma.order.update({
    where: { id: order.id },
    data: {
      status: ORDER_STATUS.APPROVED_MOCK_FULFILLMENT,
      decidedAt: new Date(),
      mockSupplierOrderId: `MOCK-CJ-${order.number}`,
      decisionNote: "Approved. SUPPLIER_MODE=mock — no CJ order was placed and no money was spent with the supplier.",
    },
  });
}

export async function declineAndRefund(orderId: string, note?: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (order.status !== ORDER_STATUS.AWAITING_MERCHANT_APPROVAL)
    throw new Error(`Order is ${order.status}; only AWAITING_MERCHANT_APPROVAL orders can be declined.`);
  if (!order.stripePaymentIntent) throw new Error("No Stripe payment intent recorded for this order.");
  const refund = await stripe().refunds.create({ payment_intent: order.stripePaymentIntent });
  return prisma.order.update({
    where: { id: order.id },
    data: {
      status: ORDER_STATUS.DECLINED_REFUNDED,
      decidedAt: new Date(),
      stripeRefundId: refund.id,
      decisionNote: note || "Declined by merchant; refunded in Stripe test mode.",
    },
  });
}
