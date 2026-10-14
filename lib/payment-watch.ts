// Watching for a payment the shopper makes in their own browser: Neon handed them a link to the checkout, and
// the run carries on by itself once the payment shows up. A check runs every few seconds, and at once when the
// shopper comes back to Chit (POST /api/assistant/runs/:id/check-payment pokes it).

import { processSingleton } from "@/lib/singleton";

const pokes = processSingleton("payment-watch-pokes", () => new Map<string, () => void>());
const EVERY_MS = 15_000;

/** Resolves with the first truthy result of `check`, polling until `signal` aborts (then it never resolves). */
export function watchPayment<T>(chatId: string, check: () => Promise<T | null>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    const stop = () => {
      if (timer) clearTimeout(timer);
      if (pokes.get(chatId) === poke) pokes.delete(chatId);
    };
    const tick = async () => {
      if (signal.aborted || running) return;
      running = true;
      if (timer) clearTimeout(timer);
      try {
        const r = await check();
        if (r && !signal.aborted) {
          stop();
          return resolve(r);
        }
      } catch {
        // A failed check (the site was slow) is just retried.
      } finally {
        running = false;
      }
      if (!signal.aborted) timer = setTimeout(tick, EVERY_MS);
    };
    const poke = () => void tick();
    pokes.set(chatId, poke);
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(tick, EVERY_MS);
  });
}

/** Checks right now (the shopper just came back to the chat). True when a payment was being watched. */
export function pokePayment(chatId: string): boolean {
  const p = pokes.get(chatId);
  p?.();
  return !!p;
}
