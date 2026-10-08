// The Chit POS mark: Bubble Guy, a peach "plant sphere" (from a macro photo) with eyes. He pops in, floats
// and breathes, blinks, wiggles now and then, jiggles when touched, bounces while thinking and shakes when
// nervous. Colors are separate drawings (peach is the brand; green, amber and red for status) and --blob-hue
// re-tints any of them. app/icon.png is the same peach drawing. Motion lives in globals.css.

export type BlobColor = "peach" | "green" | "amber" | "red";
export type BlobMood = "idle" | "thinking" | "nervous";

/** The mark (decorative next to the store name, which is always written out). */
export default function BrandMark({
  size = 30,
  className = "",
  color = "peach",
  mood = "idle",
}: {
  size?: number;
  className?: string;
  color?: BlobColor;
  mood?: BlobMood;
}) {
  // Two layers so the float (outer) and the squash and stretch (inner) don't fight over transform.
  const body = ["blob", color !== "peach" && color, mood !== "idle" && mood].filter(Boolean).join(" ");
  return (
    <span className={`brand-flag ${className}`} style={{ width: size, height: size }} aria-hidden>
      <span className={body} />
    </span>
  );
}
