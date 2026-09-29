import Link from "next/link";
import { publishedProducts } from "@/lib/storefront";
import { formatMoney } from "@/lib/money";
import { stockLabel } from "@/lib/inventory";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: `Shop — ${config.storeName}` };

export default async function ShopPage() {
  const products = await publishedProducts();
  return (
    <>
      <section className="hero">
        <h1>Tools for the pass, the line and the pastry bench.</h1>
        <p className="muted">Precision equipment chosen by chefs, shipped to your kitchen.</p>
      </section>
      {products.length === 0 ? (
        <p className="muted">No products are published yet.</p>
      ) : (
        <div className="grid">
          {products.map((p) => (
            <Link key={p.id} href={`/products/${p.slug}`} className="card product-card">
              {p.images[0] ? <img src={p.images[0].src} alt={p.images[0].alt} loading="lazy" /> : <div className="img-ph" />}
              <div className="pad">
                <h3>{p.title}</h3>
                <div className="row between">
                  <strong>{p.variants.length > 1 ? "From " : ""}{formatMoney(p.fromPriceCents)}</strong>
                  <span className={`stock stock-${p.stock}`}>{stockLabel(p.stock)}</span>
                </div>
                {p.variants.length > 1 && <div className="muted small">{p.variants.length} options</div>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
