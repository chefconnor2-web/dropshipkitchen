"use client";

import { useEffect, useState } from "react";

// "Ships to Canada" on product cards. Every badge on the page shares one request to /api/ship-check;
// answers still being worked out are asked for again every few seconds until they arrive.
type Status = { state: "ok"; cents: number | null } | { state: "no" } | { state: "pending" };
type Answer = { status: Status; countryName: string };

const answers = new Map<string, Answer>();
const listeners = new Map<string, Set<(a: Answer) => void>>();
const attempts = new Map<string, number>();
const queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const BATCH = 30;
const RETRY_MS = 2500;
const MAX_ATTEMPTS = 24; // about a minute

function ask(pid: string, delay = 40) {
  queue.add(pid);
  if (!timer) timer = setTimeout(flush, delay);
}

async function flush() {
  timer = null;
  const all = [...queue];
  queue.clear();
  for (let i = 0; i < all.length; i += BATCH) {
    const pids = all.slice(i, i + BATCH);
    try {
      const r = await fetch("/api/ship-check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pids }) });
      const d = (await r.json()) as { countryName: string; statuses: Record<string, Status> };
      for (const pid of pids) {
        const status = d.statuses[pid];
        if (!status) continue;
        const a = { status, countryName: d.countryName };
        answers.set(pid, a);
        listeners.get(pid)?.forEach((fn) => fn(a));
        if (status.state === "pending") {
          const n = (attempts.get(pid) ?? 0) + 1;
          attempts.set(pid, n);
          if (n < MAX_ATTEMPTS && listeners.get(pid)?.size) ask(pid, RETRY_MS);
        }
      }
    } catch {
      /* offline or server busy: badges just stay as they are */
    }
  }
}

/** Forget every answer and ask again (after the shopper changes country). */
export function refreshShipBadges() {
  answers.clear();
  attempts.clear();
  for (const [pid, set] of listeners) if (set.size) ask(pid);
}

export default function ShipBadge({ pid, className = "" }: { pid: string | null | undefined; className?: string }) {
  const [a, setA] = useState<Answer | undefined>(() => (pid ? answers.get(pid) : undefined));
  useEffect(() => {
    if (!pid) return;
    const set = listeners.get(pid) ?? new Set();
    listeners.set(pid, set);
    set.add(setA);
    const known = answers.get(pid);
    if (known) setA(known);
    if (!known || known.status.state === "pending") ask(pid);
    return () => {
      set.delete(setA);
    };
  }, [pid]);
  if (!pid) return null;
  if (!a) return <span className={`ship-badge ship-wait ${className}`} aria-hidden>&nbsp;</span>;
  if (a.status.state === "ok")
    return (
      <span className={`ship-badge ship-ok ${className}`}>
        <i aria-hidden /> Ships to {a.countryName}
      </span>
    );
  if (a.status.state === "no")
    return (
      <span className={`ship-badge ship-no ${className}`}>
        <i aria-hidden /> Doesn’t ship to {a.countryName}
      </span>
    );
  return (
    <span className={`ship-badge ship-wait ${className}`}>
      <i aria-hidden /> Checking shipping to {a.countryName}…
    </span>
  );
}
