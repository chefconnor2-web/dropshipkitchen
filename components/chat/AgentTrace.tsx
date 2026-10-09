"use client";
// What Neon is thinking and doing, shown the way Claude Code shows its work: a live status line (what he's on,
// seconds so far, roughly how much he's written), the summary of his reasoning streaming in, and each step he
// takes. Once he answers, it folds into "Thought for 8s", which opens to show the whole trace again.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import AgentBlob from "./AgentBlob";
import type { TraceItem } from "./ui";

// Shown while he's thinking with no step to report, a new one every few seconds.
const VERBS = ["Thinking", "Pondering", "Working it out", "Weighing options", "Connecting the dots", "Sketching a plan", "Double-checking"];

const seconds = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const tokens = (chars: number) => {
  const n = Math.round(chars / 4);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
};

function Lines({ trace }: { trace: TraceItem[] }) {
  return (
    <ol className="cx-trace-lines">
      {trace.map((t, i) =>
        t.kind === "think" ? (
          <li key={i} className="cx-trace-think">
            <span className="cx-trace-dot" aria-hidden>
              ✻
            </span>
            <span>{t.text}</span>
          </li>
        ) : (
          <li key={i} className={`cx-trace-step${t.text.startsWith("✗") ? " is-bad" : ""}`}>
            <span className="cx-trace-dot" aria-hidden>
              ⏺
            </span>
            <span>{t.text.replace(/^[✓✗]\s*/, "")}</span>
          </li>
        ),
      )}
    </ol>
  );
}

/** While the turn runs. `writing`: the answer has started, so the trace tucks itself away above it. */
export function LiveTrace({ trace, started, chars, writing, nudge }: { trace: TraceItem[]; started: number; chars: number; writing: boolean; nudge: number }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // Keep the newest line in view, like a terminal.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setOverflow(el.scrollHeight > el.clientHeight + 2);
  }, [trace]);

  // "Thought for" stops counting when the answer starts.
  const thoughtEnd = useRef<number | null>(null);
  if (writing && thoughtEnd.current === null) thoughtEnd.current = now;
  const elapsed = (thoughtEnd.current ?? now) - started;
  const last = trace[trace.length - 1];
  const status = last?.kind === "step" ? last.text.replace(/^[✓✗]\s*/, "").replace(/…$/, "") : VERBS[Math.floor(elapsed / 3500) % VERBS.length];
  const meta = `${seconds(elapsed)}${chars > 40 ? ` · ↓ ${tokens(chars)} tokens` : ""}`;

  if (writing)
    return trace.length ? (
      <details className="cx-trace is-done" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          <span className="cx-trace-sum">Thought for {seconds(elapsed)}</span>
        </summary>
        <Lines trace={trace} />
      </details>
    ) : null;

  return (
    <div className="cx-trace is-live">
      <div className="cx-trace-head">
        <AgentBlob size={30} mood="thinking" label="Neon is thinking" nudge={nudge} />
        <span className="cx-trace-status">{status}…</span>
        <span className="cx-trace-meta">{meta}</span>
      </div>
      {trace.length > 0 && (
        <div className={`cx-trace-live${overflow ? " is-overflow" : ""}`} ref={box}>
          <Lines trace={trace} />
        </div>
      )}
    </div>
  );
}

/** On a finished reply: folded away, opens to the full trace. */
export function SavedTrace({ trace, ms }: { trace?: TraceItem[]; ms?: number }) {
  if (!trace?.length) return null;
  const steps = trace.filter((t) => t.kind === "step").length;
  return (
    <details className="cx-trace is-done">
      <summary>
        <span className="cx-trace-sum">
          Thought for {seconds(ms ?? 1000)}
          {steps ? ` · ${steps} step${steps === 1 ? "" : "s"}` : ""}
        </span>
      </summary>
      <Lines trace={trace} />
    </details>
  );
}
