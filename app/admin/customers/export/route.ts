// CSV of every customer with lifetime totals. Under /admin, so the admin login protects it.
import { prisma } from "@/lib/db";
import { COUNTED_ORDER, distinctAddresses, syncCustomers } from "@/lib/customers";

export const dynamic = "force-dynamic";

function cell(v: unknown) {
  const s = v == null ? "" : String(v);
  // Quote every field; neutralise spreadsheet formulas in user-supplied text.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET() {
  await syncCustomers();
  const customers = await prisma.customer.findMany({
    include: { orders: { where: COUNTED_ORDER, orderBy: { createdAt: "desc" }, select: { subtotalCents: true, paidAt: true, createdAt: true, shippingAddressJson: true } } },
    orderBy: { createdAt: "asc" },
  });
  const head = ["name", "email", "phone", "orders", "lifetime_spend_usd", "first_order", "last_order", "city", "state", "country", "tags", "notes"];
  const lines = customers.map((c) => {
    const dates = c.orders.map((o) => o.paidAt ?? o.createdAt).sort((a, b) => a.getTime() - b.getTime());
    const a = distinctAddresses(c.orders)[0] ?? {};
    return [
      c.name, c.email, c.phone, c.orders.length,
      (c.orders.reduce((n, o) => n + o.subtotalCents, 0) / 100).toFixed(2),
      dates[0]?.toISOString().slice(0, 10), dates.at(-1)?.toISOString().slice(0, 10),
      a.city, a.state, a.country, c.tags, c.notes,
    ].map(cell).join(",");
  });
  const csv = [head.join(","), ...lines].join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
