"use client";
// Neon as a voice orb, for voice mode: one blob with four states.
//   idle       floats and blinks
//   listening  swells and squashes with your voice (the mic level, where the browser allows a second
//              listener; otherwise each new word heard gives him a bump)
//   thinking   splits into three little Neons that orbit him, with lava drops
//   speaking   bounces with each word he says
// Behind him a soft halo in the brand colours (Neon violet into Aurora mint) turns and brightens with the
// sound. The level is written straight to a CSS variable each frame, so nothing re-renders while it moves.

import { useEffect, useRef } from "react";
import BrandMark from "@/components/BrandMark";
import LavaBlob from "./LavaBlob";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
// iOS gives the microphone to one listener at a time; a level meter there would cut off speech recognition.
const sharedMicOk = () => typeof navigator !== "undefined" && !/iP(hone|ad|od)/.test(navigator.userAgent) && !!navigator.mediaDevices?.getUserMedia;

export default function NeonOrb({ state, size = 150, pulse = 0, mic = false }: { state: OrbState; size?: number; /** Bumped per word heard or said. */ pulse?: number; /** Follow the microphone level while listening. */ mic?: boolean }) {
  const root = useRef<HTMLSpanElement>(null);
  const kick = useRef(0);
  const micLevel = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (pulse) kick.current = 1;
  }, [pulse]);

  // Microphone level while listening (RMS of the waveform, smoothed in the frame loop).
  useEffect(() => {
    if (state !== "listening" || !mic || !sharedMicOk() || reducedMotion()) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const read = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += ((v - 128) / 128) ** 2;
          micLevel.current = Math.min(1, Math.sqrt(sum / buf.length) * 5);
          raf = requestAnimationFrame(read);
        };
        read();
      } catch {
        // No permission or no second listener: the word bumps still move him.
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      micLevel.current = 0;
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [state, mic]);

  // One frame loop drives --lvl (0 to 1) from whatever the current state listens to.
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    let lvl = 0;
    const tick = (t: number) => {
      const s = stateRef.current;
      kick.current *= 0.9;
      const target =
        s === "listening"
          ? Math.max(micLevel.current, kick.current * 0.7, 0.08 + 0.05 * Math.sin(t / 400))
          : s === "speaking"
            ? Math.max(kick.current * 0.85, 0.22 + 0.12 * Math.sin(t / 110) * Math.sin(t / 290))
            : s === "thinking"
              ? 0.18 + 0.1 * Math.sin(t / 600)
              : 0;
      lvl += (target - lvl) * (target > lvl ? 0.35 : 0.12);
      root.current?.style.setProperty("--lvl", lvl.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <span ref={root} className={`orb orb-${state}`} style={{ ["--s" as string]: `${size}px` }} aria-hidden>
      <span className="orb-halo" />
      <span className="orb-halo orb-halo-2" />
      {state === "thinking" ? (
        <span className="orb-lava">
          <LavaBlob size={size} split />
        </span>
      ) : (
        <span className="orb-body">
          <BrandMark size={size} mood={state === "idle" ? "idle" : "thinking"} />
        </span>
      )}
    </span>
  );
}
