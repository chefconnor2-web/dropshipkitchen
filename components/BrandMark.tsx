// The Chit POS mark, in the same family as Kitchen Cogs: a solid circle with one white shape and two soft bars.
// Here the shape is a chat bubble with a "paid" check inside (buying, done by texting), and the bars are the
// receipt's last lines. Drawn on a 48×48 grid; also saved as app/icon.svg for the favicon.

export const BRAND_ORANGE = "#E8551C";

export function brandMarkSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" role="img" aria-label="Chit POS"><circle cx="24" cy="24" r="24" fill="${BRAND_ORANGE}"/><path d="M18 10h12a6 6 0 0 1 6 6v6a6 6 0 0 1-6 6h-7.5l-5.2 3.9a.6.6 0 0 1-.96-.48V27.6A6 6 0 0 1 12 22v-6a6 6 0 0 1 6-6z" fill="white"/><path d="M19 19.2l3.4 3.3 6.6-6.6" stroke="${BRAND_ORANGE}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="19" y="32" width="12" height="2" rx="1" fill="white" opacity="0.7"/><rect x="21" y="35.5" width="8" height="2" rx="1" fill="white" opacity="0.5"/></svg>`;
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
