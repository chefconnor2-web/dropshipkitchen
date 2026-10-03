import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";

const FILTERS = { live: "Live", draft: "Hidden", all: "All" } as const;
type FilterKey = keyof typeof FILTERS;

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const filter: FilterKey = show && show in FILTERS ? (show as FilterKey) : "live";
  const [live, draft] = await Promise.all([
    prisma.product.count({ where: { status: "PUBLISHED" } }),
    prisma.product.count({ where: { status: { not: "PUBLISHED" } } }),
  ]);
  const counts: Record<FilterKey, number> = { live, draft, all: live + draft };
  const products = await prisma.product.findMany({
    where: filter === "live" ? { status: "PUBLISHED" } : filter === "draft" ? { status: { not: "PUBLISHED" } } : {},
    orderBy: { createdAt: "desc" },
    include: { variants: true, images: { take: 1, orderBy: { position: "asc" } } },
  });

  return (
    <>
      <div className="a-head">
        <h1>Products</h1>
        <Link href="/admin/suppliers/cj" className="a-btn a-btn-primary a-btn-sm">
          + Add from CJ
        </Link>
      </div>
      <div className="seg-tabs" role="tablist" aria-label="Filter products">
        {(Object.keys(FILTERS) as FilterKey[]).map((k) => (
          <Link key={k} href={`/admin/products?show=${k}`} role="tab" aria-selected={k === filter} className={k === filter ? "on" : ""}>
            {FILTERS[k]}
            <span className="seg-count">{counts[k]}</span>
          </Link>
        ))}
      </div>

      {products.length === 0 ? (
        <div className="a-empty">
          <p className="a-empty-title">Nothing here yet.</p>
          <p className="muted small">
            Import real products from <Link href="/admin/suppliers/cj">CJ</Link>, then name, price and publish them.
          </p>
        </div>
      ) : (
        <ul className="product-list">
          {products.map((p) => {
            const on = p.variants.filter((v) => v.enabled);
            const prices = (on.length ? on : p.variants).map((v) => v.priceCents);
            const lo = prices.length ? Math.min(...prices) : null;
            const hi = prices.length ? Math.max(...prices) : null;
            return (
              <li key={p.id}>
                <Link href={`/admin/products/${p.id}`} className="product-card">
                  <div className="product-thumb">{p.images[0] ? <img src={`/media/${p.images[0].id}`} alt="" loading="lazy" /> : <span />}</div>
                  <div className="product-main">
                    <div className="product-title">{p.title}</div>
                    <div className="muted small">
                      {p.categories || "No category"} · {on.length}/{p.variants.length} variants on
                    </div>
                    <div className="product-line3">
                      <span className={`chip-status ${p.status === "PUBLISHED" ? "tone-good" : "tone-muted"}`}>{p.status === "PUBLISHED" ? "Live" : "Hidden"}</span>
                      <span className="product-price">{lo == null ? "—" : lo === hi ? formatMoney(lo) : `${formatMoney(lo)}–${formatMoney(hi)}`}</span>
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
