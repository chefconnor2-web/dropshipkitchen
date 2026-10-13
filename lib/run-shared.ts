// Shared contract for assistant runs (one shopper turn executed by the server in the background), used by the
// server (lib/runs.ts, the run routes) and the chat client. Safe to import from client components: no server
// imports. See docs/frontier-port/CONTRACTS.md for the full contract.

import type { ConnectorItem } from "@/lib/flights-shared";

/** queued → running ⇄ waiting → completed | failed | cancelled | interrupted (process restarted mid-run). */
export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
export const ACTIVE_STATUSES: readonly RunStatus[] = ["queued", "running", "waiting"];
export const isActive = (s: RunStatus) => ACTIVE_STATUSES.includes(s);

export type PendingKind = "captcha" | "sign_in" | "checkout" | "choice" | "blocked";

/** A step only the shopper can do, owned by the server. The run is paused until it's resumed with this id. */
export interface PendingStep {
  /** "st_" + random; a resume must name it. */
  id: string;
  kind: PendingKind;
  /** One short line for the take-over banner. */
  message: string;
  /** The live browser this step happens in (browser service session id), and its card id ("br_" + session). */
  browser: { sessionId: string; cardId: string } | null;
  createdAt: string;
  /** After this the run stops waiting and tells the shopper it gave up (the step is then stale). */
  expiresAt: string;
}

export interface LiveCard {
  pid: string;
  title: string;
  fromCents: number;
  group?: string;
}
export interface LiveGroup {
  group: string;
  cards: LiveCard[];
  done: boolean;
}
export interface LiveTraceItem {
  kind: "think" | "step";
  text: string;
}

/** The reply being written: rebuilt identically on the server (for reconnect snapshots) and in the browser. */
export interface PartialEntry {
  text: string;
  steps: string[];
  groups: LiveGroup[];
  items: ConnectorItem[];
  trace: LiveTraceItem[];
  /** The assistant's tapback on the shopper's message, once picked. */
  reaction: string | null;
  /** Characters written (text + thinking), for "↓ 1.2k tokens". */
  chars: number;
}

/** Live events while a run executes (same shapes the chat used before runs existed). */
export type LiveEvent =
  | { type: "progress"; note: string }
  | { type: "found"; group: string; cards: LiveCard[]; done: boolean }
  | { type: "items"; group: string; items: ConnectorItem[] }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "break" }
  | { type: "react"; emoji: string };

export interface RunSnapshot {
  id: string;
  chatId: string;
  status: RunStatus;
  /** Last event sequence number folded into `partial`. */
  seq: number;
  /** Index of the shopper's message in the chat transcript (the reply goes right after it). */
  userIndex: number;
  partial: PartialEntry;
  pending: PendingStep | null;
  /** Shopper-facing error for failed / interrupted runs. */
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Final payload once a run completes (the saved assistant entry, as uiJson stores it). */
export interface RunDone {
  entry: Record<string, unknown> & { role: "assistant"; id: string; text: string };
  reaction: string | null;
  cartCount: number;
  allowance: { remaining: number; limit: number; subscriber: boolean } | null;
}

/** Server-sent events on GET /api/assistant/runs/:id/events. Every frame carries its `seq` (also the SSE id). */
export type RunFrame =
  | { type: "snapshot"; seq: number; run: RunSnapshot }
  | { type: "event"; seq: number; event: LiveEvent }
  | { type: "status"; seq: number; status: RunStatus; error: string | null }
  | { type: "pending"; seq: number; pending: PendingStep | null }
  | { type: "title"; seq: number; chatId: string; title: string }
  | { type: "done"; seq: number; done: RunDone };

/** POST /api/assistant/runs/:id/resume → 200 only with accepted: true; 409 with accepted: false. */
export type ResumeResult =
  | { accepted: true; runId: string; stepId: string; status: RunStatus; duplicate?: boolean }
  | { accepted: false; reason: "stale_step" | "not_waiting" | "run_finished" | "expired"; message: string; current: RunSnapshot | null };

/** POST /api/assistant/runs/:id/cancel. */
export type CancelResult = { cancelled: boolean; run: RunSnapshot };

/** POST /api/assistant/runs → 202 (or 200 when clientRequestId repeats an accepted run). */
export interface RunAccepted {
  run: RunSnapshot;
  chat: { id: string; title: string; isNew: boolean };
  /** The shopper's message as saved (with its id), at run.userIndex. */
  user: Record<string, unknown> & { role: "user"; id: string };
  duplicate: boolean;
}

export const emptyPartial = (): PartialEntry => ({ text: "", steps: [], groups: [], items: [], trace: [], reaction: null, chars: 0 });

const MAX_TRACE_ITEMS = 60;

/** Folds one live event into the reply being written. Pure: returns a new object, never mutates `p`. */
export function applyEvent(p: PartialEntry, e: LiveEvent): PartialEntry {
  switch (e.type) {
    case "progress": {
      const steps = p.steps[p.steps.length - 1] === e.note ? p.steps : [...p.steps, e.note];
      const trace =
        e.note !== "Thinking…" && p.trace[p.trace.length - 1]?.text !== e.note ? [...p.trace, { kind: "step" as const, text: e.note }].slice(-MAX_TRACE_ITEMS) : p.trace;
      return { ...p, steps, trace };
    }
    case "thinking": {
      const last = p.trace[p.trace.length - 1];
      const trace = last?.kind === "think" ? [...p.trace.slice(0, -1), { ...last, text: last.text + e.delta }] : [...p.trace, { kind: "think" as const, text: e.delta }].slice(-MAX_TRACE_ITEMS);
      return { ...p, trace, chars: p.chars + e.delta.length };
    }
    case "text":
      return { ...p, text: p.text + e.delta, chars: p.chars + e.delta.length };
    case "break":
      return p.text && !p.text.endsWith("\n\n") ? { ...p, text: p.text + "\n\n" } : p;
    case "found": {
      const prev = p.groups.find((x) => x.group === e.group);
      // While searching, accumulate finds; when the scout is done, show its shortlist.
      const cards = e.done
        ? e.cards.length
          ? e.cards
          : (prev?.cards.slice(0, 3) ?? [])
        : [...(prev?.cards ?? []), ...e.cards.filter((c) => !prev?.cards.some((q) => q.pid === c.pid))].slice(0, 8);
      const next = { group: e.group, cards, done: e.done };
      return { ...p, groups: prev ? p.groups.map((x) => (x.group === e.group ? next : x)) : [...p.groups, next] };
    }
    case "items": {
      // A card with an id already shown replaces it in place (e.g. the live browser asking the shopper to take over).
      const fresh = new Map(e.items.map((x) => [x.id, x]));
      return { ...p, items: [...p.items.map((y) => fresh.get(y.id) ?? y), ...e.items.filter((x) => !p.items.some((y) => y.id === x.id))] };
    }
    case "react":
      return { ...p, reaction: e.emoji };
  }
}

/** Folds a run frame into a snapshot (client and server agree on the result). Frames at or below snapshot.seq are ignored. */
export function applyFrame(run: RunSnapshot, f: RunFrame): RunSnapshot {
  if (f.type === "snapshot") return f.run.seq >= run.seq || f.run.id !== run.id ? f.run : run;
  if (f.seq <= run.seq) return run;
  switch (f.type) {
    case "event":
      return { ...run, seq: f.seq, partial: applyEvent(run.partial, f.event) };
    case "status":
      return { ...run, seq: f.seq, status: f.status, error: f.error, ...(isActive(f.status) ? {} : { pending: null }) };
    case "pending":
      return { ...run, seq: f.seq, pending: f.pending, status: f.pending ? "waiting" : run.status === "waiting" ? "running" : run.status };
    case "title":
      return { ...run, seq: f.seq };
    case "done":
      return { ...run, seq: f.seq, status: "completed", pending: null };
  }
}

/* ---------- Server-sent events: one format writer, one incremental parser (any chunk boundaries). ---------- */

export function formatSse(f: RunFrame): string {
  return `id: ${f.seq}\nevent: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`;
}

/**
 * Incremental SSE parser. Feed it decoded text in arbitrary pieces; it returns the complete frames so far.
 * Handles \n, \r\n and \r line endings, comments (": ping"), multi-line data and partial lines across chunks.
 */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private lastId: string | null = null;

  /** The id of the last complete event (for resuming with ?after=). */
  get lastEventId(): string | null {
    return this.lastId;
  }

  feed(chunk: string): RunFrame[] {
    this.buf += chunk;
    const out: RunFrame[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      if (!m) break;
      // A lone \r at the end may be the first half of \r\n: wait for the next chunk.
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      if (line === "") {
        if (this.data.length) {
          const raw = this.data.join("\n");
          this.data = [];
          try {
            const f = JSON.parse(raw) as RunFrame;
            if (f && typeof f === "object" && typeof (f as { type?: unknown }).type === "string") out.push(f);
          } catch {
            /* a malformed frame is skipped, never fatal */
          }
        }
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
      else if (field === "id") this.lastId = value;
    }
    return out;
  }
}
