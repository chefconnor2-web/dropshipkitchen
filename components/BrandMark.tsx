// The Chit POS mark: Bubble Guy, the COGSio character. A glossy blob that breathes while idle, wobbles while
// thinking and shakes when nervous. Colors are separate drawings (purple is the brand; green, amber and red
// for status), and --blob-hue can re-tint any of them. app/icon.png is the same purple drawing.

export type BlobColor = "purple" | "green" | "amber" | "red";
export type BlobMood = "idle" | "thinking" | "nervous";

/** The mark (decorative next to the store name, which is always written out). */
export default function BrandMark({
  size = 30,
  className = "",
  color = "purple",
  mood = "idle",
}: {
  size?: number;
  className?: string;
  color?: BlobColor;
  mood?: BlobMood;
}) {
  const cls = ["brand-flag", "blob", color !== "purple" && color, mood !== "idle" && mood, className].filter(Boolean).join(" ");
  return <span className={cls} style={{ width: size, height: size }} aria-hidden />;
}
