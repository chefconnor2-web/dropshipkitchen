// The chat's side of a server-owned assistant run: the event-stream subscriber (fetch + ReadableStream +
// SseParser rather than EventSource, so HTTP statuses are visible) and the create / cancel / resume / snapshot
// calls. Framework-free so it can be tested with an injected fetch. Contract: docs/frontier-port/CONTRACTS.md
// §5 (HTTP API), §6 (frames) and §9 (client transports).

import { SseParser, applyFrame, isActive, type CancelResult, type ResumeResult, type RunAccepted, type RunDone, type RunFrame, type RunSnapshot } from "./run-shared";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

const runUrl = (runId: string) => `/api/assistant/runs/${encodeURIComponent(runId)}`;

/** Connection to the run's event stream, as the chat shows it. */
export type RunConnection = "connecting" | "live" | "reconnecting" | "offline" | "closed";
/** Why a subscription stopped by itself: the run ended, or it isn't there (deleted, or not this shopper's). */
export type RunEndReason = "terminal" | "not_found";

/** Waits between reconnect attempts (§9): 0.5, 1, 2, 4, 8, 8 s, then "Connection lost — tap to reconnect". */
export const RECONNECT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 8000];
/** A connection that stayed open this long counts as healthy, so the next drop starts the backoff over. */
const HEALTHY_MS = 10_000;
/** Coming back to the tab after less than this keeps a live stream as it is. */
const BRIEF_HIDE_MS = 2_000;

type Listenable = { addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void };

export interface SubscribeOptions {
  /** Last seq already folded in (e.g. a snapshot's seq): only newer frames are asked for. */
  after?: number;
  onFrame: (f: RunFrame) => void;
  onConnection?: (state: RunConnection) => void;
  /** The subscription stopped by itself (not called after close()). */
  onEnd?: (reason: RunEndReason) => void;
  /** For tests. */
  fetch?: FetchLike;
  backoffMs?: readonly number[];
  /** Where `online` and `visibilitychange` come from (defaults to window and document in a browser; null for none). */
  env?: { win: Listenable | null; doc: (Listenable & { visibilityState?: string }) | null };
}

export interface RunSubscription {
  /** Stops for good (switching chats, unmount). The run itself keeps going on the server. */
  close(): void;
  /** Reconnects now, starting the backoff over ("tap to reconnect"). */
  reconnect(): void;
}

/**
 * Follows a run's frames: GET /api/assistant/runs/:id/events?after=<last seq>. Frames are delivered in order and
 * at most once (anything at or below the last seq seen is dropped; a snapshot always passes, it replaces state).
 * Reconnects with backoff, and right away on `online` or when the page becomes visible again. Stops on a terminal
 * frame, a 404, or close(). When the retries run out it reports "offline" and fetches one snapshot.
 */
export function subscribeRun(runId: string, opts: SubscribeOptions): RunSubscription {
  const doFetch = opts.fetch ?? defaultFetch;
  const backoff = opts.backoffMs ?? RECONNECT_BACKOFF_MS;
  const win = opts.env ? opts.env.win : typeof window !== "undefined" ? (window as Listenable) : null;
  const doc = opts.env ? opts.env.doc : typeof document !== "undefined" ? (document as Listenable & { visibilityState?: string }) : null;

  let lastSeq: number | null = typeof opts.after === "number" ? opts.after : null;
  let state: RunConnection | null = null;
  let tries = 0;
  let ended = false;
  /** Bumped on every (re)connect and on close: work belonging to an older generation stops quietly. */
  let gen = 0;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The run completed (status or snapshot) but its `done` frame hasn't arrived yet. */
  let completed = false;
  let hiddenAt = 0;

  const setState = (s: RunConnection) => {
    if (state === s) return;
    state = s;
    opts.onConnection?.(s);
  };
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const stop = () => {
    ended = true;
    gen++;
    clearTimer();
    ctrl?.abort();
    ctrl = null;
    win?.removeEventListener("online", onOnline);
    doc?.removeEventListener("visibilitychange", onVisibility);
    setState("closed");
  };
  const finish = (reason: RunEndReason) => {
    if (ended) return;
    stop();
    opts.onEnd?.(reason);
  };

  /** Hands one frame on; true when it ends the subscription. */
  const deliver = (f: RunFrame): boolean => {
    if (f.type !== "snapshot" && lastSeq !== null && f.seq <= lastSeq) return false;
    lastSeq = f.seq;
    opts.onFrame(f);
    if (ended) return true;
    if (f.type === "done") return true;
    const status = f.type === "status" ? f.status : f.type === "snapshot" ? f.run.status : null;
    if (status && !isActive(status)) {
      // A completed run is followed by its `done` (the saved reply): keep reading until it comes.
      if (status === "completed") completed = true;
      else return true;
    }
    return false;
  };

  /** The stream closed after the run completed but before `done`: fetch it once, then stop either way. */
  const settleCompleted = async (my: number) => {
    const r = await getRun(runId, doFetch);
    if (ended || my !== gen) return;
    if (r && r !== "not_found" && r.done) opts.onFrame({ type: "done", seq: Math.max(r.run.seq, lastSeq ?? 0), done: r.done });
    finish("terminal");
  };

  const goOffline = async (my: number) => {
    setState("offline");
    const r = await getRun(runId, doFetch);
    if (ended || my !== gen) return;
    if (r === "not_found") return finish("not_found");
    if (!r) return; // still unreachable; a tap, `online` or coming back to the page reconnects
    lastSeq = Math.max(lastSeq ?? 0, r.run.seq);
    opts.onFrame({ type: "snapshot", seq: r.run.seq, run: r.run });
    if (ended || my !== gen) return;
    if (!isActive(r.run.status)) {
      if (r.done) opts.onFrame({ type: "done", seq: r.run.seq, done: r.done });
      finish("terminal");
    }
  };

  const drop = (my: number) => {
    if (ended || my !== gen) return;
    if (tries >= backoff.length) return void goOffline(my);
    const wait = backoff[tries++];
    setState("reconnecting");
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void connect("reconnecting");
    }, wait);
  };

  const connect = async (mode: "connecting" | "reconnecting") => {
    if (ended) return;
    clearTimer();
    ctrl?.abort();
    const my = ++gen;
    const c = new AbortController();
    ctrl = c;
    setState(mode);
    const url = `${runUrl(runId)}/events${lastSeq === null ? "" : `?after=${lastSeq}`}`;
    let res: Response;
    try {
      res = await doFetch(url, { signal: c.signal, cache: "no-store", headers: { accept: "text/event-stream" } });
    } catch {
      return drop(my);
    }
    if (ended || my !== gen) {
      res.body?.cancel().catch(() => {});
      return;
    }
    if (res.status === 404 || res.status === 410) {
      res.body?.cancel().catch(() => {});
      return finish("not_found");
    }
    if (!res.ok || !res.body) {
      res.body?.cancel().catch(() => {});
      return drop(my);
    }
    setState("live");
    const opened = Date.now();
    let progressed = false;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (ended || my !== gen) {
          reader.cancel().catch(() => {});
          return;
        }
        const text = chunk.done ? dec.decode() : dec.decode(chunk.value, { stream: true });
        for (const f of parser.feed(text)) {
          progressed = true;
          if (deliver(f)) {
            reader.cancel().catch(() => {});
            return finish("terminal");
          }
          if (ended || my !== gen) return; // onFrame closed or reconnected
        }
        if (chunk.done) break;
      }
    } catch {
      /* dropped mid-stream: reconnect below */
    }
    if (ended || my !== gen) return;
    if (completed) return void settleCompleted(my);
    if (progressed || Date.now() - opened >= HEALTHY_MS) tries = 0;
    drop(my);
  };

  const wake = () => {
    if (ended) return;
    tries = 0;
    // A live stream is restarted quietly (a phone may have frozen it in the background); otherwise say so.
    void connect(state === "live" ? "connecting" : "reconnecting");
  };
  const onOnline = () => wake();
  const onVisibility = () => {
    if (!doc) return;
    if (doc.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    if (doc.visibilityState !== "visible") return;
    if (state === "live" && hiddenAt && Date.now() - hiddenAt < BRIEF_HIDE_MS) return;
    wake();
  };
  win?.addEventListener("online", onOnline);
  doc?.addEventListener("visibilitychange", onVisibility);

  void connect("connecting");

  return {
    close: () => {
      if (!ended) stop();
    },
    reconnect: () => wake(),
  };
}

/**
 * applyFrame, plus one rule for the chat: a snapshot saying the run has ended always ends it here too. After a
 * server restart the stored seq can lag behind what this page already saw, and applyFrame would ignore it.
 */
export function foldRun(run: RunSnapshot, f: RunFrame): RunSnapshot {
  const next = applyFrame(run, f);
  if (next === run && f.type === "snapshot" && f.run.id === run.id && isActive(run.status) && !isActive(f.run.status)) {
    return { ...run, status: f.run.status, error: f.run.error, pending: null, finishedAt: f.run.finishedAt };
  }
  return next;
}

/* ---------- One-off calls ---------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = async (r: Response): Promise<Record<string, unknown>> => {
  try {
    const d = (await r.json()) as unknown;
    return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** 8–64 chars of [A-Za-z0-9_-], fresh per send (§2). */
export function newClientRequestId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface CreateRunBody {
  clientRequestId: string;
  message: string;
  chatId?: string;
  images?: string[];
  voice?: boolean;
  editIndex?: number;
  docs?: Array<{ name: string; kind: string; data: string }>;
}

export type CreateRunResult =
  | { ok: true; status: number; accepted: RunAccepted }
  /** status 0: the server couldn't be reached. `body` is the error JSON (402 carries limit and plans, 409 activeRun). */
  | { ok: false; status: number; error: string; body: Record<string, unknown> };

export const UNREACHABLE = "Couldn't reach Neon. Check your connection and try again.";

/**
 * POST /api/assistant/runs. A network failure is retried twice with the same clientRequestId, which the server
 * dedupes (200 duplicate), so a send that did land is never started twice.
 */
export async function createRun(body: CreateRunBody, doFetch: FetchLike = defaultFetch, retryMs: readonly number[] = [500, 1500]): Promise<CreateRunResult> {
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await doFetch("/api/assistant/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      if (attempt < retryMs.length) {
        await sleep(retryMs[attempt]);
        continue;
      }
      return { ok: false, status: 0, error: UNREACHABLE, body: {} };
    }
    const d = await json(r);
    if ((r.status === 200 || r.status === 202) && d.run && d.chat && d.user) return { ok: true, status: r.status, accepted: d as unknown as RunAccepted };
    return { ok: false, status: r.status, error: typeof d.error === "string" && d.error ? d.error : "Something went wrong.", body: d };
  }
}

/** POST /api/assistant/runs/:id/cancel. Null when it couldn't be reached (never throws). */
export async function cancelRun(runId: string, doFetch: FetchLike = defaultFetch): Promise<CancelResult | null> {
  try {
    const r = await doFetch(`${runUrl(runId)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const d = await json(r);
    return typeof d.cancelled === "boolean" && d.run ? (d as unknown as CancelResult) : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/assistant/runs/:id/resume. Returns the server's answer as is, for 200 and 409 alike (callers check
 * `accepted === true && stepId === sent`, never the HTTP status). Never throws: when Neon can't be reached (or
 * answers with something else) it resolves as not_waiting with current: null, so the take-over stays open.
 */
export async function resumeRun(runId: string, stepId: string, doFetch: FetchLike = defaultFetch): Promise<ResumeResult> {
  const offline: ResumeResult = { accepted: false, reason: "not_waiting", message: "Couldn't reach Neon. Try again.", current: null };
  try {
    const r = await doFetch(`${runUrl(runId)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stepId }) });
    const d = await json(r);
    if (typeof d.accepted === "boolean") return d as unknown as ResumeResult;
    if (r.status === 404) return { accepted: false, reason: "run_finished", message: typeof d.error === "string" && d.error ? d.error : "This run has ended.", current: null };
    return offline;
  } catch {
    return offline;
  }
}

/** GET /api/assistant/runs/:id: the run and, once completed, its saved reply. "not_found" on 404; null when unreachable. */
export async function getRun(runId: string, doFetch: FetchLike = defaultFetch): Promise<{ run: RunSnapshot; done: RunDone | null } | "not_found" | null> {
  try {
    const r = await doFetch(runUrl(runId), { cache: "no-store" });
    if (r.status === 404) return "not_found";
    if (!r.ok) return null;
    const d = await json(r);
    return d.run ? { run: d.run as RunSnapshot, done: (d.done as RunDone | null) ?? null } : null;
  } catch {
    return null;
  }
}
