import { notFound } from "next/navigation";
import { publishedProduct } from "@/lib/storefront";
import { config } from "@/lib/config";
import VariantPicker from "./VariantPicker";
import Gallery from "./Gallery";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const p = await publishedProduct((await params).slug);
  if (!p) return {};
  return { title: p.seoTitle || `${p.title} — ${config.storeName}`, description: p.seoDescription || p.description.slice(0, 160) };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const p = await publishedProduct((await params).slug);
  if (!p) notFound();
  return (
    <div className="pdp">
      <Gallery images={p.images} />
      <div>
        {p.categories.length > 0 && <div className="muted small">{p.categories.join(" · ")}</div>}
        <h1>{p.title}</h1>
        <VariantPicker optionNames={p.optionNames} variants={p.variants} />
        {p.estimatedDelivery && (
          <p className="small">
            <strong>Estimated delivery:</strong> {p.estimatedDelivery}
          </p>
        )}
        {p.description && (
          <div className="description">
            {p.description.split("\n").map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
