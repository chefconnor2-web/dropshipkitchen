import Link from "next/link";
import { notFound } from "next/navigation";
import { publishedProduct } from "@/lib/storefront";
import { config } from "@/lib/config";
import ProductView from "./ProductView";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const p = await publishedProduct((await params).slug);
  if (!p) return {};
  return { title: p.seoTitle || `${p.title} — ${config.storeName}`, description: p.seoDescription || p.description.slice(0, 160) };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const p = await publishedProduct((await params).slug);
  if (!p) notFound();
  const category = p.categories[0];
  return (
    <>
      <nav className="crumbs small" aria-label="Breadcrumb">
        <Link href="/shop">Shop</Link>
        {category && (
          <>
            {" / "}
            <Link href={`/shop?category=${encodeURIComponent(category)}`}>{category}</Link>
          </>
        )}
        {" / "}
        <span>{p.title}</span>
      </nav>
      <ProductView product={p} />
      {p.description && (
        <section className="pdp-details">
          <h2 className="section-title">Details</h2>
          <div className="description">
            {p.description
              .split("\n")
              .filter((l) => l.trim())
              .map((l, i) => (
                <p key={i}>{l}</p>
              ))}
          </div>
        </section>
      )}
    </>
  );
}
