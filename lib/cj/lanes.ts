// CJ allows a few calls per second per account, so every call waits in one in-process line for its start. A shopper
// waiting on a button jumps ahead of background work (catalog warm-up, imports nobody is waiting for).
// A call's priority comes from the async context it is made in: see withCjPriority.
import { AsyncLocalStorage } from "node:async_hooks";
import { processSingleton } from "@/lib/singleton";

export const CJ_PRIORITY = { background: 0, normal: 1, urgent: 2 } as const;
export type CjPriority = keyof typeof CJ_PRIORITY;

/** A mutable priority shared by every CJ call made inside one withCjPriority context. */
export interface CjLane {
  priority: number;
}

const lanes = processSingleton("cj-lanes", () => new AsyncLocalStorage<CjLane>());

/** Run fn with every CJ call it makes (directly or not) queued at this priority. */
export function withCjPriority<T>(priority: CjPriority | CjLane, fn: () => T): T {
  return lanes.run(typeof priority === "string" ? { priority: CJ_PRIORITY[priority] } : priority, fn);
}

/** The lane CJ calls made here would join (a fresh normal lane outside any withCjPriority). */
export function currentCjLane(): CjLane {
  return lanes.getStore() ?? { priority: CJ_PRIORITY.normal };
}

/**
 * Starts queued calls at least minIntervalMs apart (CJ's limit is on request rate), highest priority first,
 * then oldest, with up to maxConcurrent in flight: a slow CJ reply doesn't hold up the next call's start.
 * Background work never fills the last slot, so a shopper's call (a tap on Add) always has one free.
 */
export function makeThrottle(minIntervalMs: () => number, maxConcurrent: () => number = () => 1) {
  const waiting: Array<{ lane: CjLane; seq: number; run: () => Promise<void> }> = [];
  let seq = 0;
  let pumping = false;
  let lastStartAt = 0;
  let running = 0;
  let wake: (() => void) | null = null;

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length) {
        const max = Math.max(1, maxConcurrent());
        if (running >= max) {
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        const wait = lastStartAt + minIntervalMs() - Date.now();
        if (wait > 0) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        // Priorities are read now, so a lane promoted while it waited counts.
        let next = 0;
        for (let i = 1; i < waiting.length; i++) {
          const a = waiting[i], b = waiting[next];
          if (a.lane.priority > b.lane.priority || (a.lane.priority === b.lane.priority && a.seq < b.seq)) next = i;
        }
        // Only background work is waiting and one slot is left: keep it for a shopper.
        if (max > 1 && running >= max - 1 && waiting[next].lane.priority <= CJ_PRIORITY.background) {
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        const [job] = waiting.splice(next, 1);
        running++;
        lastStartAt = Date.now();
        void job.run().finally(() => {
          running--;
          const w = wake;
          wake = null;
          w?.();
        });
      }
    } finally {
      pumping = false;
    }
  }

  return function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const lane = currentCjLane();
    return new Promise<T>((resolve, reject) => {
      waiting.push({ lane, seq: seq++, run: () => fn().then(resolve, reject) });
      // A pump parked on the reserved slot re-checks when a shopper's call arrives.
      const w = wake;
      wake = null;
      w?.();
      void pump();
    });
  };
}
