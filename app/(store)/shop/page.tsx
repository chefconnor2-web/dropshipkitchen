import Link from "next/link";
import { publishedCategories, publishedProducts, type PublicProduct } from "@/lib/storefront";
import { config } from "@/lib/config";
import ProductCard from "@/components/store/ProductCard";

export const dynamic = "force-dynamic";
export const metadata = { title: `Shop all tools — ${config.storeName}` };

const SORTS = {
  featured: { label: "Featured", fn: null },
  "price-asc": { label: "Price: low to high", fn: (a: PublicProduct, b: PublicProduct) => price(a) - price(b) },
  "price-desc": { label: "Price: high to low", fn: (a: PublicProduct, b: PublicProduct) => price(b) - price(a) },
} as const;
type SortKey = keyof typeof SORTS;

function price(p: PublicProduct) {
  return p.fromPriceCents ?? Number.MAX_SAFE_INTEGER;
}

function href(category: string | null, sort: SortKey) {
  const q = new URLSearchParams();
  if (category) q.set("category", category);
  if (sort !== "featured") q.set("sort", sort);
  return q.size ? `/shop?${q}` : "/shop";
}

export default async function ShopPage({ searchParams }: { searchParams: Promise<{ category?: string; sort?: string }> }) {
  const params = await searchParams;
  const [all, categories] = await Promise.all([publishedProducts(), publishedCategories()]);
  const category = categories.some((c) => c.name === params.category) ? params.category! : null;
  const sort: SortKey = params.sort && params.sort in SORTS ? (params.sort as SortKey) : "featured";

  let products = category ? all.filter((p) => p.categories.includes(category)) : all;
  const cmp = SORTS[sort].fn;
  if (cmp) products = [...products].sort(cmp);

  return (
    <div className="wrap page">
      <form className="shop-search" role="search" action="/search">
        <label className="sr-only" htmlFor="shop-q">
          Search all products
        </label>
        <input id="shop-q" name="q" type="search" placeholder="Can’t see it? Search every product we can ship" />
        <button className="btn">Search</button>
      </form>

      <section id="catalog" className="catalog">
        <div className="catalog-head">
          <div>
            {category && (
              <nav className="crumbs small" aria-label="Breadcrumb">
                <Link href="/shop">Shop</Link> / <span>{category}</span>
              </nav>
            )}
            <p className="eyebrow">Tools &amp; gadgets</p>
            <h1 className="section-title">{category ?? "Everything on the shelf"}</h1>
            <div className="muted small">
              {products.length} product{products.length === 1 ? "" : "s"}
            </div>
          </div>
          <div className="sort small" role="group" aria-label="Sort products">
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <Link key={k} href={href(category, k)} className={k === sort ? "on" : ""} aria-current={k === sort ? "true" : undefined}>
                {SORTS[k].label}
              </Link>
            ))}
          </div>
        </div>

        {categories.length > 1 && (
          <div className="filters" role="group" aria-label="Filter by category">
            <Link href={href(null, sort)} className={`chip ${category ? "" : "on"}`}>
              All <span className="chip-n">{all.length}</span>
            </Link>
            {categories.map((c) => (
              <Link key={c.name} href={href(c.name, sort)} className={`chip ${c.name === category ? "on" : ""}`}>
                {c.name} <span className="chip-n">{c.count}</span>
              </Link>
            ))}
          </div>
        )}

        {products.length === 0 ? (
          <p className="muted empty">New gear is being tested. Check back soon.</p>
        ) : (
          <div className="pgrid">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
