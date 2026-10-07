// The Chit POS mark: a receipt (a "chit") that is also a chat bubble — buying, done by texting.
// White receipt with item lines and a total, a torn zigzag edge that ends in a speech tail, on the brand orange.
// Drawn on a 64×64 grid; also saved as app/icon.svg for the favicon.

const RECEIPT =
  "M19 9 H45 Q48 9 48 12 V46 L45 49 L42 46 L39 49 L36 46 L33 49 L30 46 L27 49 L24 46 L21 49 L19.5 47.5 L11 55 L16 44.5 V12 Q16 9 19 9 Z";

export function brandMarkSvg(): string {
  const line = (y: number, w: number) => `<rect x="21" y="${y}" width="${w}" height="3" rx="1.5" fill="#15171A" opacity="0.28"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Chit POS"><rect width="64" height="64" rx="14" fill="#E8551C"/><path d="${RECEIPT}" fill="#FFFFFF"/>${line(16, 18)}${line(22.5, 13)}${line(29, 16)}<rect x="21" y="36" width="9" height="4" rx="2" fill="#15171A"/><rect x="34" y="36" width="9" height="4" rx="2" fill="#E8551C"/></svg>`;
}

/** The mark as an inline image (decorative next to the store name, which is always written out). */
export default function BrandMark({ size = 30, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`brand-flag ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: brandMarkSvg() }}
    />
  );
}
