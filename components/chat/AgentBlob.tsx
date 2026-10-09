"use client";
// Neon, alive in the chat. Small things people feel more than notice: he turns a little toward your pointer,
// leans in while you type and nods along with your keystrokes, bobs as he writes, and hops when something lands
// in your cart. Everything is gentle and stops for people who prefer reduced motion.

import { useEffect, useRef } from "react";
import BrandMark, { type BlobColor, type BlobMood } from "@/components/BrandMark";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function AgentBlob({
  size = 26,
  color = "neon",
  mood = "idle",
  label,
  className = "",
  attentive = false,
  nudge = 0,
  cheer = 0,
}: {
  size?: number;
  color?: BlobColor;
  mood?: BlobMood;
  label?: string;
  className?: string;
  /** The shopper is typing: lean toward the message box. */
  attentive?: boolean;
  /** Bumped on each keystroke or burst of words: a small nod. */
  nudge?: number;
  /** Bumped when something is added to the cart: a happy hop. */
  cheer?: number;
}) {
  const look = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  const lastNod = useRef(0);

  // Turn a little toward the pointer: more when it's close, never more than a few degrees.
  useEffect(() => {
    if (reducedMotion()) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = look.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1;
        const pull = Math.min(1, 320 / (d + 160));
        el.style.setProperty("--lx", ((dx / d) * pull).toFixed(3));
        el.style.setProperty("--ly", ((dy / d) * pull).toFixed(3));
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  useEffect(() => {
    if (!nudge || reducedMotion() || !body.current) return;
    const now = performance.now();
    if (now - lastNod.current < 240) return;
    lastNod.current = now;
    const tilt = (Math.random() - 0.5) * 6;
    body.current.animate(
      [
        { transform: "scale(1, 1) rotate(0deg)" },
        { transform: `scale(1.05, 0.95) rotate(${tilt}deg)` },
        { transform: "scale(1, 1) rotate(0deg)" },
      ],
      { duration: 280, easing: "cubic-bezier(.3,.7,.4,1)" },
    );
  }, [nudge]);

  useEffect(() => {
    if (!cheer || reducedMotion() || !body.current) return;
    body.current.animate(
      [
        { transform: "translateY(0) scale(1, 1)" },
        { transform: "translateY(0) scale(1.12, 0.86)", offset: 0.18 },
        { transform: "translateY(-38%) scale(0.92, 1.1)", offset: 0.45 },
        { transform: "translateY(0) scale(1.1, 0.9)", offset: 0.75 },
        { transform: "translateY(0) scale(1, 1)" },
      ],
      { duration: 720, easing: "ease-out" },
    );
    look.current?.classList.remove("is-cheer");
    void look.current?.offsetWidth; // restart the sparkle
    look.current?.classList.add("is-cheer");
  }, [cheer]);

  return (
    <span ref={look} className={`agent-blob${attentive ? " is-attentive" : ""} ${className}`}>
      <span ref={body} className="agent-blob-body">
        <BrandMark size={size} color={color} mood={mood} label={label} />
      </span>
    </span>
  );
}
