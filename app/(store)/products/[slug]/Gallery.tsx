"use client";

import { useState } from "react";

export default function Gallery({ images }: { images: Array<{ src: string; alt: string }> }) {
  const [i, setI] = useState(0);
  if (images.length === 0) return <div className="img-ph big" />;
  return (
    <div className="gallery">
      <img className="gallery-main" src={images[i].src} alt={images[i].alt} />
      {images.length > 1 && (
        <div className="thumbs">
          {images.map((img, k) => (
            <button key={img.src} className={k === i ? "active" : ""} onClick={() => setI(k)} type="button">
              <img src={img.src} alt={img.alt} loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
