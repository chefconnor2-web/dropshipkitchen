"use client";

import { useEffect, useState } from "react";

type Img = { src: string; alt: string };

/**
 * Product images plus the selected variant's own image. Choosing a variant shows its image;
 * clicking a thumbnail goes back to browsing the product images.
 */
export default function Gallery({ images, variantImage }: { images: Img[]; variantImage: Img | null }) {
  const [i, setI] = useState<number | "variant">(variantImage ? "variant" : 0);

  useEffect(() => {
    if (variantImage) setI("variant");
  }, [variantImage?.src]);

  const main = i === "variant" && variantImage ? variantImage : images[i === "variant" ? 0 : i];
  if (!main) return <div className="img-ph big" />;

  const thumbs: Array<{ img: Img; key: number | "variant" }> = [
    ...(variantImage && !images.some((im) => im.src === variantImage.src) ? [{ img: variantImage, key: "variant" as const }] : []),
    ...images.map((img, k) => ({ img, key: k })),
  ];

  return (
    <div className="gallery">
      <div className="gallery-frame">
        <img className="gallery-main" key={main.src} src={main.src} alt={main.alt} />
      </div>
      {thumbs.length > 1 && (
        <div className="thumbs" role="list">
          {thumbs.map(({ img, key }) => (
            <button
              key={img.src}
              type="button"
              role="listitem"
              className={key === i || (key === 0 && i === "variant" && !variantImage) ? "active" : ""}
              aria-label={key === "variant" ? "Selected option image" : `Image ${Number(key) + 1}`}
              onClick={() => setI(key)}
            >
              <img src={img.src} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
