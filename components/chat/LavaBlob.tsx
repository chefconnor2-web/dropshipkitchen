"use client";
// Neon while you wait, like a lava lamp: now and then a drop of him swells, pulls away, floats up and sinks
// back in. When other agents are working with him (Aurora's scouts searching), they sit beside him and their
// bodies flow into each other, passing drops back and forth.
//
// The goo is an SVG filter on a layer of plain dark shapes under the drawings: blur, then a sharp alpha cutoff,
// so shapes that come close melt together. The drawings sit on top and hide the shapes under them.

import { useId } from "react";
import AgentBlob from "./AgentBlob";
import BrandMark from "@/components/BrandMark";

const MAX_HELPERS = 3;

export default function LavaBlob({ size = 30, helpers = 0, nudge = 0, label }: { size?: number; helpers?: number; nudge?: number; label?: string }) {
  const id = useId().replace(/:/g, "");
  const n = Math.max(0, Math.min(MAX_HELPERS, Math.round(helpers)));
  const gap = size * 0.78;
  const width = size + n * gap;
  return (
    <span className="lava" style={{ width, height: size, ["--s" as string]: `${size}px`, ["--gap" as string]: `${gap}px` }} aria-hidden={label ? undefined : true}>
      <svg className="lava-defs" width="0" height="0" aria-hidden>
        <filter id={`goo${id}`} x="-50%" y="-80%" width="200%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation={Math.max(1.6, size / 11)} result="b" />
          <feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" />
        </filter>
      </svg>
      <span className="lava-goo" style={{ filter: `url(#goo${id}) drop-shadow(0 0 ${Math.max(2, Math.round(size / 9))}px rgb(168 120 255 / 0.8))` }}>
        <i className="lava-core" />
        <i className="lava-drop d1" />
        <i className="lava-drop d2" />
        <i className="lava-drop d3" />
        {Array.from({ length: n }, (_, i) => (
          <span key={i} className="lava-pair" style={{ ["--i" as string]: i }}>
            <i className="lava-core is-helper" />
            <i className="lava-pass" />
          </span>
        ))}
      </span>
      <span className="lava-lead">
        <AgentBlob size={size} mood="thinking" label={label} nudge={nudge} />
      </span>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="lava-helper" style={{ ["--i" as string]: i }}>
          <BrandMark size={Math.round(size * 0.82)} color="aurora" mood="thinking" />
        </span>
      ))}
    </span>
  );
}
