import Link from "next/link";
import { notFound } from "next/navigation";
import { publishedProduct } from "@/lib/storefront";
import { config } from "@/lib/config";
import ProductView from "./ProductView";
import { getShipTo } from "@/lib/cart";
import { fastShipView } from "@/lib/ship-view";
import { prisma } from "@/lib/db";
import { warehouseLabel, warehousesFrom } from "@/lib/warehouses";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const p = await publishedProduct((await params).slug);
  if (!p) return {};
  const title = p.seoTitle || `${p.title} — ${config.storeName}`;
  const description = p.seoDescription || p.description.slice(0, 160);
  // The product photo is the preview card when the page is shared.
  const images = p.images[0] ? [{ url: p.images[0].src, alt: p.images[0].alt }] : undefined;
  return { title, description, openGraph: { title, description, url: `/products/${p.slug}`, siteName: config.storeName, type: "website", images }, twitter: { card: "summary_large_image", title, description, images } };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const p = await publishedProduct((await params).slug);
  if (!p) notFound();
  const category = p.categories[0];
  const shipTo = await getShipTo();
  // Shipping for the first option, from memory or an estimate (never waits on CJ), so it's there on first paint.
  const firstVariant = p.variants.find((v) => v.stock !== "UNAVAILABLE") ?? p.variants[0];
  const stock = await prisma.productVariant.findMany({
    where: { id: { in: p.variants.map((v) => v.id) } },
    select: { offer: { select: { cjSupplierVariant: { select: { inventoryJson: true } } } } },
  });
  const warehouse = warehouseLabel(warehousesFrom(stock.map((v) => v.offer?.cjSupplierVariant.inventoryJson)));
  const initialShip = firstVariant ? { variantId: firstVariant.id, view: await fastShipView(firstVariant.id, 1, shipTo.country, shipTo.zip) } : null;
  return (
    <div className="wrap page">
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
      <ProductView product={p} shipTo={{ country: shipTo.country, zip: shipTo.zip }} initialShip={initialShip} warehouse={warehouse} storeName={config.storeName} />
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
    </div>
  );
}
