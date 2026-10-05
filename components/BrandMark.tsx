// The C1 mark: China, Canada and the US side by side, the three countries the store sources from and ships to.
// Left: China red with a gold star. Middle: Canada, a red maple leaf on white. Right: the US, a navy canton with
// a white star over red and white stripes. Drawn on a 64×64 grid; also saved as app/icon.svg for the favicon.

const STAR = (cx: number, cy: number, r: number) =>
  Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.42 : r;
    return `${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`;
  }).join(" ");

// A stylized, symmetric maple leaf in a 20×20 box (top at y=0, stem to y=20).
const LEAF = "10,0 12,4 14.6,3 13.6,8.2 17.2,6 16.2,9.2 20,10.2 17,12.4 18,15.2 13,14.1 11.6,15.2 11,14.6 11,20 9,20 9,14.6 8.4,15.2 7,14.1 2,15.2 3,12.4 0,10.2 3.8,9.2 2.8,6 6.4,8.2 5.4,3 8,4";

export function brandMarkSvg(): string {
  const leaf = LEAF.split(" ")
    .map((p) => {
      const [x, y] = p.split(",").map(Number);
      return `${(21.5 + x * 1.05).toFixed(2)},${(21 + y * 1.1).toFixed(2)}`;
    })
    .join(" ");
  const stripes = [0, 1, 2, 3, 4]
    .map((i) => `<rect x="43" y="${30 + i * 6.8}" width="21" height="3.4" fill="#B22234"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="C1"><defs><clipPath id="c1r"><rect width="64" height="64" rx="14"/></clipPath></defs><g clip-path="url(#c1r)"><rect width="21.5" height="64" fill="#DE2910"/><polygon points="${STAR(10.75, 20, 7)}" fill="#FFDE00"/><polygon points="${STAR(16.5, 33, 2.4)}" fill="#FFDE00"/><polygon points="${STAR(16.5, 40, 2.4)}" fill="#FFDE00"/><rect x="21.5" width="21.5" height="64" fill="#FFFFFF"/><polygon points="${leaf}" fill="#D80621"/><rect x="43" width="21" height="64" fill="#FFFFFF"/>${stripes}<rect x="43" width="21" height="28" fill="#0A3161"/><polygon points="${STAR(53.5, 14, 6)}" fill="#FFFFFF"/></g><rect x="0.75" y="0.75" width="62.5" height="62.5" rx="13.25" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="1.5"/></svg>`;
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
