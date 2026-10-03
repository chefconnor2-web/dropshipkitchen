import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Flash, StatusChip, timeAgo } from "@/components/admin";
import { COUNTED_ORDER, distinctAddresses, parseTags } from "@/lib/customers";
import { saveCustomerAction } from "@/app/admin/actions";

function fmtDate(d: Date | null | undefined) {
  return d ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(d) : "—";
}

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { id } = await params;
  const { notice, error } = await searchParams;
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: { orders: { orderBy: { createdAt: "desc" }, include: { items: true } } },
  });
  if (!customer) notFound();

  const allOrders = customer.orders.filter((o) => o.status !== "PENDING_PAYMENT");
  const counted = await prisma.order.findMany({ where: { customerId: id, ...COUNTED_ORDER }, select: { subtotalCents: true, paidAt: true, createdAt: true } });
  const spend = counted.reduce((n, o) => n + o.subtotalCents, 0);
  const dates = counted.map((o) => o.paidAt ?? o.createdAt).sort((a, b) => a.getTime() - b.getTime());
  const refunded = allOrders.filter((o) => o.status === "DECLINED_REFUNDED").length;
  const addresses = distinctAddresses(allOrders);

  // What they buy: one row per product across paid orders.
  const bought = new Map<string, { title: string; productId: string | null; qty: number; spend: number; variants: Set<string> }>();
  for (const o of allOrders) {
    if (!(COUNTED_ORDER.status.in as string[]).includes(o.status)) continue;
    for (const i of o.items) {
      const key = i.productId ?? i.productTitle;
      const row = bought.get(key) ?? { title: i.productTitle, productId: i.productId, qty: 0, spend: 0, variants: new Set<string>() };
      row.qty += i.quantity;
      row.spend += i.customerPriceCents * i.quantity;
      if (!/^default$/i.test(i.variantName)) row.variants.add(i.variantName);
      bought.set(key, row);
    }
  }
  const products = [...bought.values()].sort((a, b) => b.spend - a.spend);
  const tags = parseTags(customer.tags);

  return (
    <>
      <Link href="/admin/customers" className="a-back">
        ‹ Customers
      </Link>
      <div className="a-head">
        <div className="cust-head">
          <div className="avatar avatar-lg" aria-hidden>
            {(customer.name || customer.email).trim().slice(0, 1).toUpperCase()}
          </div>
          <div>
            <h1>{customer.name || customer.email}</h1>
            <div className="a-sub">Customer since {fmtDate(dates[0] ?? customer.createdAt)}</div>
          </div>
        </div>
      </div>
      <Flash notice={notice} error={error} />
      {tags.length > 0 && (
        <div className="tag-row">
          {tags.map((t) => (
            <span key={t} className="tag tag-plain">
              {t}
            </span>
          ))}
        </div>
      )}

      <section className="kpis">
        <div className="kpi">
          <span className="kpi-v">{formatMoney(spend)}</span>
          <span className="kpi-k">Lifetime spend</span>
        </div>
        <div className="kpi">
          <span className="kpi-v">{counted.length}</span>
          <span className="kpi-k">
            Paid order{counted.length === 1 ? "" : "s"}
            {refunded ? ` · ${refunded} refunded` : ""}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-v">{counted.length ? formatMoney(Math.round(spend / counted.length)) : "—"}</span>
          <span className="kpi-k">Average order</span>
        </div>
        <div className="kpi">
          <span className="kpi-v kpi-v-sm">{timeAgo(dates.at(-1))}</span>
          <span className="kpi-k">Last order</span>
        </div>
      </section>

      <section className="a-card">
        <h2 className="a-h2">Contact</h2>
        <div className="contact-row contact-row-top">
          <a className="pill-btn" href={`mailto:${customer.email}`}>
            ✉ {customer.email}
          </a>
          {customer.phone && (
            <a className="pill-btn" href={`tel:${customer.phone}`}>
              ☎ {customer.phone}
            </a>
          )}
        </div>
        {addresses.length > 0 && (
          <>
            <h2 className="a-h2 a-h2-gap">Ship-to address{addresses.length === 1 ? "" : `es (${addresses.length})`}</h2>
            <div className="addr-list">
              {addresses.map((a, n) => (
                <address key={n} className="ship-to addr">
                  {a.name && (
                    <>
                      <strong>{a.name}</strong>
                      <br />
                    </>
                  )}
                  {a.line1}
                  {a.line2 ? `, ${a.line2}` : ""}
                  <br />
                  {[a.city, a.state, a.postal_code].filter(Boolean).join(", ")} · {a.country}
                  {n === 0 && addresses.length > 1 && <span className="tag tag-plain addr-tag">Latest</span>}
                </address>
              ))}
            </div>
          </>
        )}
      </section>

      {products.length > 0 && (
        <section className="a-card">
          <h2 className="a-h2">What they buy</h2>
          <ul className="item-list">
            {products.map((p) => (
              <li key={p.title} className="item-row">
                <div className="item-main">
                  <div className="item-title">{p.productId ? <Link href={`/admin/products/${p.productId}`}>{p.title}</Link> : p.title}</div>
                  <div className="muted small">
                    {p.qty} bought{p.variants.size ? ` · ${[...p.variants].join(", ")}` : ""}
                  </div>
                </div>
                <div className="item-amt">{formatMoney(p.spend)}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="a-card">
        <h2 className="a-h2">Orders ({allOrders.length})</h2>
        <ul className="mini-list">
          {allOrders.map((o) => (
            <li key={o.id}>
              <Link href={`/admin/orders/${o.id}`}>
                <span className="strong">
                  {o.items[0]?.productTitle ?? o.number}
                  {o.items.length > 1 ? ` + ${o.items.length - 1}` : ""}
                </span>
                <span className="muted small">
                  {fmtDate(o.paidAt ?? o.createdAt)} · {o.number}
                </span>
                <span className="mini-right">
                  {formatMoney(o.subtotalCents)} <StatusChip status={o.status} sandbox={o.cjSandbox} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="a-card">
        <h2 className="a-h2">Notes &amp; tags</h2>
        <form action={saveCustomerAction} className="cust-form">
          <input type="hidden" name="customerId" value={customer.id} />
          <label>
            Name
            <input name="name" defaultValue={customer.name ?? ""} autoComplete="off" />
          </label>
          <label>
            Phone
            <input name="phone" type="tel" defaultValue={customer.phone ?? ""} autoComplete="off" />
          </label>
          <label>
            Tags <span className="muted">(comma separated, e.g. VIP, wholesale)</span>
            <input name="tags" defaultValue={customer.tags} autoComplete="off" />
          </label>
          <label>
            Private notes <span className="muted">(only you see these)</span>
            <textarea name="notes" rows={4} defaultValue={customer.notes} placeholder="e.g. prefers fast shipping, ordered for a job site in Boise" />
          </label>
          <button className="a-btn a-btn-primary">Save customer</button>
        </form>
      </section>
    </>
  );
}
