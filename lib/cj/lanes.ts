// CJ allows a few calls per second per account, so every call waits in one in-process line. A shopper
// waiting on a button jumps ahead of background work (catalog warm-up, imports nobody is waiting for).
// A call's priority comes from the async context it is made in: see withCjPriority.
import { AsyncLocalStorage } from "node:async_hooks";

export const CJ_PRIORITY = { background: 0, normal: 1, urgent: 2 } as const;
export type CjPriority = keyof typeof CJ_PRIORITY;

/** A mutable priority shared by every CJ call made inside one withCjPriority context. */
export interface CjLane {
  priority: number;
}

const lanes = new AsyncLocalStorage<CjLane>();

/** Run fn with every CJ call it makes (directly or not) queued at this priority. */
export function withCjPriority<T>(priority: CjPriority | CjLane, fn: () => T): T {
  return lanes.run(typeof priority === "string" ? { priority: CJ_PRIORITY[priority] } : priority, fn);
}

/** The lane CJ calls made here would join (a fresh normal lane outside any withCjPriority). */
export function currentCjLane(): CjLane {
  return lanes.getStore() ?? { priority: CJ_PRIORITY.normal };
}

/** Runs queued calls one at a time, at least minIntervalMs apart, highest priority first, then oldest. */
export function makeThrottle(minIntervalMs: () => number) {
  const waiting: Array<{ lane: CjLane; seq: number; run: () => Promise<void> }> = [];
  let seq = 0;
  let pumping = false;
  let lastCallAt = 0;

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length) {
        const wait = lastCallAt + minIntervalMs() - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        // Priorities are read now, so a lane promoted while it waited counts.
        let next = 0;
        for (let i = 1; i < waiting.length; i++) {
          const a = waiting[i], b = waiting[next];
          if (a.lane.priority > b.lane.priority || (a.lane.priority === b.lane.priority && a.seq < b.seq)) next = i;
        }
        const [job] = waiting.splice(next, 1);
        try {
          await job.run();
        } finally {
          lastCallAt = Date.now();
        }
      }
    } finally {
      pumping = false;
    }
  }

  return function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const lane = currentCjLane();
    return new Promise<T>((resolve, reject) => {
      waiting.push({ lane, seq: seq++, run: () => fn().then(resolve, reject) });
      void pump();
    });
  };
}
