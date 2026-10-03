import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { timeAgo } from "@/components/admin";
import { COUNTED_ORDER, parseTags, syncCustomers } from "@/lib/customers";

const SORTS = { recent: "Recent", spend: "Top spend", orders: "Most orders" } as const;
type SortKey = keyof typeof SORTS;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; sort?: string }> }) {
  const { q = "", sort: sortParam } = await searchParams;
  const sort: SortKey = sortParam && sortParam in SORTS ? (sortParam as SortKey) : "recent";
  await syncCustomers();

  const term = q.trim();
  const customers = await prisma.customer.findMany({
    where: term
      ? { OR: [{ email: { contains: term.toLowerCase() } }, { name: { contains: term } }, { phone: { contains: term } }, { tags: { contains: term } }] }
      : {},
    include: { orders: { where: COUNTED_ORDER, select: { subtotalCents: true, paidAt: true, createdAt: true } } },
    take: 500,
  });
  const rows = customers
    .map((c) => {
      const spend = c.orders.reduce((n, o) => n + o.subtotalCents, 0);
      const last = c.orders.reduce<Date | null>((d, o) => {
        const t = o.paidAt ?? o.createdAt;
        return !d || t > d ? t : d;
      }, null);
      return { c, spend, count: c.orders.length, last };
    })
    .sort((a, b) =>
      sort === "spend" ? b.spend - a.spend : sort === "orders" ? b.count - a.count : (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0),
    );
  const total = rows.reduce((n, r) => n + r.spend, 0);
  const qs = (s: SortKey) => `/admin/customers?${new URLSearchParams({ ...(term ? { q: term } : {}), sort: s })}`;

  return (
    <>
      <div className="a-head">
        <div>
          <h1>Customers</h1>
          <div className="a-sub">
            {rows.length} customer{rows.length === 1 ? "" : "s"} · {formatMoney(total)} lifetime
          </div>
        </div>
        <a href="/admin/customers/export" className="a-btn a-btn-sm">
          Export CSV
        </a>
      </div>
      <form className="search-bar" role="search">
        <input type="search" name="q" defaultValue={term} placeholder="Search name, email, phone or tag" aria-label="Search customers" />
        <input type="hidden" name="sort" value={sort} />
        <button className="a-btn a-btn-sm">Search</button>
      </form>
      <div className="seg-tabs" role="tablist" aria-label="Sort customers">
        {(Object.keys(SORTS) as SortKey[]).map((k) => (
          <Link key={k} href={qs(k)} role="tab" aria-selected={k === sort} className={k === sort ? "on" : ""}>
            {SORTS[k]}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="a-empty">
          <p className="a-empty-title">{term ? `No customers match “${term}”.` : "No customers yet."}</p>
          <p className="muted small">Everyone who pays for an order shows up here automatically.</p>
        </div>
      ) : (
        <ul className="order-list">
          {rows.map(({ c, spend, count, last }) => (
            <li key={c.id}>
              <Link href={`/admin/customers/${c.id}`} className="order-card">
                <div className="avatar" aria-hidden>
                  {(c.name || c.email).trim().slice(0, 1).toUpperCase()}
                </div>
                <div className="order-main">
                  <div className="order-line1">
                    <span className="order-who">{c.name || c.email}</span>
                    <span className="order-total">{formatMoney(spend)}</span>
                  </div>
                  <div className="order-items">{c.email}</div>
                  <div className="order-line3">
                    <span className="muted">
                      {count} order{count === 1 ? "" : "s"} · last {timeAgo(last)}
                    </span>
                    {parseTags(c.tags).map((t) => (
                      <span key={t} className="tag tag-plain">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                <span className="chev" aria-hidden>
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
