"use client";

import { useState } from "react";
import type { PublicProduct, PublicVariant } from "@/lib/storefront";
import Gallery from "./Gallery";
import VariantPicker from "./VariantPicker";
import type { ShipView } from "@/lib/ship-view";
import ShareButton from "@/components/ShareButton";

export default function ProductView({
  product: p,
  shipTo,
  initialShip,
  warehouse,
  storeName,
}: {
  product: PublicProduct;
  storeName: string;
  /** Where it ships from and to, e.g. "US warehouse · ships to US addresses only". */
  warehouse?: string | null;
  shipTo: { country: string; zip: string };
  initialShip?: { variantId: string; view: ShipView } | null;
}) {
  const initial = p.variants.find((v) => v.stock !== "UNAVAILABLE") ?? p.variants[0] ?? null;
  const [variant, setVariant] = useState<PublicVariant | null>(initial);
  const variantImage = variant?.imageSrc ? { src: variant.imageSrc, alt: `${p.title} — ${variant.name}` } : null;

  return (
    <div className="pdp">
      <Gallery images={p.images} variantImage={variantImage} />
      <div className="pdp-info">
        {p.categories.length > 0 && <div className="overline">{p.categories.join(" · ")}</div>}
        <h1 className="pdp-title">{p.title}</h1>
        <ShareButton className="pdp-share" url={`/products/${p.slug}`} text={`${p.title} on ${storeName}`} image={p.images[0]?.src} />
        <VariantPicker
          shipTo={shipTo}
          optionNames={p.optionNames}
          variants={p.variants}
          initial={initial}
          onChange={setVariant}
          personalize={p.personalize}
          initialShip={initialShip}
          mockupSrc={variant?.imageSrc ?? p.images[0]?.src ?? null}
        />
        <ul className="assurances">
          {warehouse && (
            <li className="pdp-warehouse">
              <strong>Ships from</strong> {warehouse}
            </li>
          )}
          {p.estimatedDelivery && (
            <li>
              <strong>Estimated delivery</strong> {p.estimatedDelivery}
            </li>
          )}
          <li>
            <strong>Live availability</strong> Stock is confirmed again before you pay
          </li>
          <li>
            <strong>Secure checkout</strong> Card payments processed by Stripe
          </li>
        </ul>
      </div>
    </div>
  );
}
