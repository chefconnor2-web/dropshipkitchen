"use client";
// Neon while you wait, like a lava lamp. Now and then a drop of him swells, pulls away, floats up and sinks back
// in. Every so often while he thinks, and the whole time he's searching, he splits into three little copies of
// himself that circle him like planets, then melt back in.
//
// One character: the drops are pieces of Neon himself. The goo is an SVG filter on a layer of shapes in his own
// body color under him (blur, then a sharp alpha cutoff, so shapes that come close melt together); each drop
// also wears his artwork on top, so what leaves him looks like him, not a separate purple blob.

import { useId } from "react";
import AgentBlob from "./AgentBlob";
import BrandMark from "@/components/BrandMark";

const PLANETS = 3;

export default function LavaBlob({ size = 30, split = false, nudge = 0, label }: { size?: number; split?: boolean; nudge?: number; label?: string }) {
  const id = useId().replace(/:/g, "");
  const planet = Math.round(size * 0.44);
  return (
    <span
      className={`lava${split ? " is-split" : ""}`}
      style={{ width: size * 2.1, height: size, ["--s" as string]: `${size}px`, ["--p" as string]: `${planet}px` }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <svg className="lava-defs" width="0" height="0" aria-hidden>
        <filter id={`goo${id}`} x="-50%" y="-80%" width="200%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation={Math.max(1.6, size / 11)} result="b" />
          <feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" />
        </filter>
      </svg>
      <span className="lava-goo" style={{ filter: `url(#goo${id})` }}>
        <i className="lava-core" />
        <i className="lava-drop d1" />
        <i className="lava-drop d2" />
        <i className="lava-drop d3" />
        {Array.from({ length: PLANETS }, (_, i) => (
          <span key={i} className={`lava-orbit o${i}`}>
            <i className="lava-moon" />
          </span>
        ))}
      </span>
      <span className="lava-skin" aria-hidden>
        <i className="lava-drop d1" />
        <i className="lava-drop d2" />
        <i className="lava-drop d3" />
      </span>
      <span className="lava-lead">
        <AgentBlob size={size} mood="thinking" nudge={nudge} />
      </span>
      {Array.from({ length: PLANETS }, (_, i) => (
        <span key={i} className={`lava-orbit o${i}`}>
          <BrandMark size={planet} mood="thinking" />
        </span>
      ))}
    </span>
  );
}
