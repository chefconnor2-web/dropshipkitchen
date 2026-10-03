import Link from "next/link";
import type { PublicProduct } from "@/lib/storefront";
import { formatMoney } from "@/lib/money";

export default function ProductCard({ product: p }: { product: PublicProduct }) {
  const [first, second] = p.images;
  const badge = p.stock === "UNAVAILABLE" ? "Sold out" : p.stock === "LOW_STOCK" ? "Low stock" : null;
  const word = p.optionNames.length === 1 && !/^default$/i.test(p.optionNames[0]) ? p.optionNames[0].toLowerCase() : "option";
  const optionLabel = `${p.variants.length} ${word.endsWith("s") ? word : `${word}s`}`;
  return (
    <Link href={`/products/${p.slug}`} className="pcard">
      <div className="pcard-media">
        {first ? (
          <>
            <img src={first.src} alt={first.alt} loading="lazy" />
            {second && <img className="pcard-alt" src={second.src} alt="" loading="lazy" aria-hidden />}
          </>
        ) : (
          <div className="img-ph" />
        )}
        {badge && <span className={`pcard-badge badge-${p.stock}`}>{badge}</span>}
      </div>
      <div className="pcard-body">
        {p.categories[0] && <div className="overline">{p.categories[0]}</div>}
        <h3 className="pcard-title">{p.title}</h3>
        <div className="pcard-foot">
          <span className="pcard-price">
            {p.variants.length > 1 && <span className="from">From </span>}
            {formatMoney(p.fromPriceCents)}
          </span>
          {p.variants.length > 1 && (
            <span className="muted small">{optionLabel}</span>
          )}
        </div>
      </div>
    </Link>
  );
}
