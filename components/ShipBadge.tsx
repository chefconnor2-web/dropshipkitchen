"use client";

import { useEffect, useState } from "react";

// "Ships to Canada · from China" on product cards, and "US warehouse · ships to US only" where that's the
// reason it can't reach the shopper. Every badge on the page shares one request to /api/ship-check;
// answers still being worked out are asked for again every few seconds until they arrive.
// provisional: answered by the default (China) while the warehouse is being confirmed; the badge shows it
// right away and quietly asks again until it's confirmed.
type Status = { state: "ok"; cents: number | null; from?: string | null; provisional?: boolean } | { state: "no"; from?: string | null } | { state: "pending" };
type Answer = { status: Status; countryName: string; country: string };

const answers = new Map<string, Answer>();
const listeners = new Map<string, Set<(a: Answer) => void>>();
const attempts = new Map<string, number>();
const queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const BATCH = 30;
const RETRY_MS = 4000;
const MAX_ATTEMPTS = 15; // about a minute

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
      const d = (await r.json()) as { country: string; countryName: string; statuses: Record<string, Status> };
      for (const pid of pids) {
        const status = d.statuses[pid];
        if (!status) continue;
        const a = { status, countryName: d.countryName, country: d.country };
        answers.set(pid, a);
        listeners.get(pid)?.forEach((fn) => fn(a));
        if (status.state === "pending" || (status.state === "ok" && status.provisional)) {
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
    if (!known || known.status.state === "pending" || (known.status.state === "ok" && known.status.provisional)) ask(pid);
    return () => {
      set.delete(setA);
    };
  }, [pid]);
  if (!pid) return null;
  if (!a) return <span className={`ship-badge ship-wait ${className}`} aria-hidden>&nbsp;</span>;
  if (a.status.state === "ok") {
    const from = (a.status.from ?? "").split(",");
    // US addresses go from the US warehouse when it has stock; everything else comes from China.
    // Domestic stock first: Canada's warehouse for Canadian addresses, the US warehouse for US ones.
    const origin =
      a.country === "CA" && from.includes("CA")
        ? "Canada · 3–7 days"
        : a.country === "US" && from.includes("US")
          ? "US warehouse"
          : from.includes("CN")
            ? "China"
            : null;
    return (
      <span className={`ship-badge ship-ok ${className}`}>
        <i aria-hidden />
        <span>
          Ships to {a.countryName}
          {origin && <span className="ship-from"> · from {origin}</span>}
        </span>
      </span>
    );
  }
  if (a.status.state === "no")
    return (
      <span className={`ship-badge ship-no ${className}`}>
        <i aria-hidden />
        <span>
          {a.status.from === "US" && a.country !== "US"
            ? "US warehouse · ships to US only"
            : a.status.from === "CA" && a.country !== "CA"
              ? "Canadian warehouse · ships within Canada only"
              : `Doesn’t ship to ${a.countryName}`}
        </span>
      </span>
    );
  return (
    <span className={`ship-badge ship-wait ${className}`}>
      <i aria-hidden /> Checking shipping to {a.countryName}…
    </span>
  );
}
