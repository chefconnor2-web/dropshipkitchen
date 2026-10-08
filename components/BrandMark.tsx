// The Chit mark and the two Chit agents: Bubble Guy in Neon (the lead, who answers in every chat) and Aurora
// (who does the searching). A near-black sphere whose veins glow; light flows along the veins, faster while
// the agent is working. He pops in, floats and breathes, blinks, wiggles now and then and jiggles when
// touched. The older peach, green, amber and red drawings remain for status use. Motion lives in globals.css;
// the drawings come from scripts/make-agents.py.

export type BlobColor = "neon" | "aurora" | "peach" | "green" | "amber" | "red";
export type BlobMood = "idle" | "thinking" | "nervous";

const AGENTS = new Set<BlobColor>(["neon", "aurora"]);

/** The mark (decorative next to a name or message, which is always written out). */
export default function BrandMark({
  size = 30,
  className = "",
  color = "neon",
  mood = "idle",
  label,
}: {
  size?: number;
  className?: string;
  color?: BlobColor;
  mood?: BlobMood;
  /** Name it for screen readers when it stands for an agent on its own (e.g. under a reply). */
  label?: string;
}) {
  // Two layers so the float (outer) and the squash and stretch (inner) don't fight over transform.
  const body = ["blob", color, mood !== "idle" && mood].filter(Boolean).join(" ");
  return (
    <span className={`brand-flag ${className}`} style={{ width: size, height: size }} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <span className={body}>{AGENTS.has(color) && <span className="blob-flow" />}</span>
    </span>
  );
}
