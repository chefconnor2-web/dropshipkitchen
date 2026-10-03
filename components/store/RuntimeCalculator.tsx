"use client";

import { useState } from "react";
import { BATTERY_AH, DRAW_WATTS, NOMINAL_VOLTS, runtimeHours } from "@/lib/lineup";

const USES = [
  { key: "light", label: "Light", note: "Messaging, maps" },
  { key: "typical", label: "Typical", note: "Browsing, calls" },
  { key: "heavy", label: "Heavy", note: "Video, uploads" },
] as const;

export default function RuntimeCalculator() {
  const [ah, setAh] = useState<number>(5);
  const [count, setCount] = useState(1);
  const [use, setUse] = useState<keyof typeof DRAW_WATTS>("typical");
  const watts = DRAW_WATTS[use];
  const hours = runtimeHours(ah, count, watts);
  const wh = NOMINAL_VOLTS * ah * count;

  return (
    <div className="calc">
      <div className="calc-inputs">
        <fieldset>
          <legend>Battery size</legend>
          <div className="seg">
            {BATTERY_AH.map((a) => (
              <button key={a} type="button" aria-pressed={ah === a} className={ah === a ? "on" : ""} onClick={() => setAh(a)}>
                {a}Ah
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Batteries</legend>
          <div className="seg">
            {[1, 2, 3, 4].map((n) => (
              <button key={n} type="button" aria-pressed={count === n} className={count === n ? "on" : ""} onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>How you use it</legend>
          <div className="seg seg-wide">
            {USES.map((u) => (
              <button key={u.key} type="button" aria-pressed={use === u.key} className={use === u.key ? "on" : ""} onClick={() => setUse(u.key)}>
                <span>{u.label}</span>
                <span className="seg-note">{u.note}</span>
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="calc-result" aria-live="polite">
        <div className="calc-label">Hours online</div>
        <div className="calc-hours">
          {hours.toFixed(1)}
          <span>h</span>
        </div>
        <dl className="plate">
          <dt>Energy</dt>
          <dd>
            {count} × 18V {ah}Ah = {wh} Wh
          </dd>
          <dt>Draw</dt>
          <dd>{watts} W</dd>
          <dt>Formula</dt>
          <dd>{wh} Wh × 0.9 ÷ {watts} W</dd>
        </dl>
        <p className="calc-foot">Estimates for Starlink Mini. Real draw varies with weather, obstructions and firmware.</p>
      </div>
    </div>
  );
}
