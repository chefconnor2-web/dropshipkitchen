// Customers are derived from paid orders: one per email address. The merchant adds notes and tags.

import { prisma } from "@/lib/db";

const PAID_STATUSES = ["AWAITING_MERCHANT_APPROVAL", "PLACING_SUPPLIER_ORDER", "SUPPLIER_ORDER_PLACED", "APPROVED_MOCK_FULFILLMENT"];

/** Orders that count toward a customer's spend (paid and not refunded). */
export const COUNTED_ORDER = { status: { in: PAID_STATUSES } };

/** Links one order to its customer (by email), creating or updating the customer's contact details. */
export async function linkOrderToCustomer(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order?.email) return null;
  const email = order.email.trim().toLowerCase();
  const customer = await prisma.customer.upsert({
    where: { email },
    create: { email, name: order.customerName, phone: order.customerPhone },
    // Newest order wins for contact details, but never blank out what we already have.
    update: { ...(order.customerName ? { name: order.customerName } : {}), ...(order.customerPhone ? { phone: order.customerPhone } : {}) },
  });
  if (order.customerId !== customer.id) await prisma.order.update({ where: { id: order.id }, data: { customerId: customer.id } });
  return customer;
}

/** Links any paid orders that don't have a customer yet (older orders, or ones paid before this existed). */
export async function syncCustomers() {
  const loose = await prisma.order.findMany({
    where: { customerId: null, email: { not: null }, status: { not: "PENDING_PAYMENT" } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: 500,
  });
  for (const o of loose) await linkOrderToCustomer(o.id);
  return loose.length;
}

export function parseTags(tags: string): string[] {
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export interface ShipAddress {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
}

/** Distinct shipping addresses from a customer's orders, newest first. */
export function distinctAddresses(orders: Array<{ shippingAddressJson: string | null }>): ShipAddress[] {
  const seen = new Set<string>();
  const out: ShipAddress[] = [];
  for (const o of orders) {
    if (!o.shippingAddressJson) continue;
    try {
      const s = JSON.parse(o.shippingAddressJson);
      const a: ShipAddress = { name: s.name, ...(s.address ?? {}) };
      const key = [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].map((x) => (x ?? "").toLowerCase().trim()).join("|");
      if (key.replace(/\|/g, "") && !seen.has(key)) {
        seen.add(key);
        out.push(a);
      }
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}
