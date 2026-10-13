// Assistant runs: one shopper turn, accepted at once and executed by this server process in the background.
//
// Ownership (docs/frontier-port/CONTRACTS.md §1): the storefront runs as ONE replica (SQLite on a volume), so
// this process owns every run. In memory: the abort controller, the event ring buffer and live subscribers, and
// the waiter for a step only the shopper can do. In the database (AssistantRun): status, the reply written so
// far, the pending step and the error, so a reconnecting phone (or a restart) sees the truth. A restart can't
// continue a half-finished tool loop, so runs that were active are marked "interrupted" at boot.

import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { processSingleton } from "@/lib/singleton";
import { AssistantLimitError, chatTurn, generateTitle, type UiEntry } from "@/lib/assistant";
import { aiAllowance, recordAiUse } from "@/lib/membership";
import { releaseShopperControl } from "@/lib/browser";
import { docInfo, type DocUpload } from "@/lib/docs-shared";
import {
  applyEvent,
  emptyPartial,
  isActive,
  type LiveEvent,
  type PartialEntry,
  type PendingKind,
  type PendingStep,
  type ResumeResult,
  type RunAccepted,
  type RunDone,
  type RunFrame,
  type RunSnapshot,
  type RunStatus,
} from "@/lib/run-shared";

const MAX_ACTIVE = () => Math.max(1, Number(process.env.ASSISTANT_MAX_ACTIVE_RUNS) || 12);
const WAIT_MS = () => Math.max(1, Number(process.env.ASSISTANT_WAIT_MINUTES) || 15) * 60_000;
const RING = 2000;
const FLUSH_MS = 750;
/** A finished run stays in memory this long, so a phone reconnecting just after the end still gets `done`. */
const KEEP_FINISHED_MS = 5 * 60_000;
export const INTERRUPTED_ERROR = "Neon restarted before finishing. Tap retry.";

/* ---------- Pure decisions (unit-tested in tests/runs.test.ts) ---------- */

export type ResumeDecision =
  | { kind: "accept" }
  | { kind: "duplicate" }
  | { kind: "reject"; reason: "stale_step" | "not_waiting" | "run_finished" | "expired"; message: string };

/** What POST /resume should do, given the run's current state. Accept only the exact step it is waiting on. */
export function decideResume(
  s: { status: RunStatus; pending: PendingStep | null; lastResumedStep: string | null; expiredSteps?: ReadonlySet<string> },
  stepId: string,
  now = Date.now(),
): ResumeDecision {
  if (!isActive(s.status)) return { kind: "reject", reason: "run_finished", message: "Neon has already finished this." };
  if (s.pending && s.pending.id === stepId) {
    if (Date.parse(s.pending.expiresAt) <= now) return { kind: "reject", reason: "expired", message: "That step timed out. Ask Neon to try again." };
    return { kind: "accept" };
  }
  if (s.pending) return { kind: "reject", reason: "stale_step", message: "Neon needs something else from you now." };
  if (stepId && stepId === s.lastResumedStep) return { kind: "duplicate" };
  if (s.expiredSteps?.has(stepId)) return { kind: "reject", reason: "expired", message: "That step timed out. Ask Neon to try again." };
  return { kind: "reject", reason: "not_waiting", message: "Neon isn't waiting on you right now." };
}

/** Frames to replay after `after` from the ring, or null when a snapshot is needed (gap, or no `after`). */
export function replayFrom(ring: readonly RunFrame[], after: number | null, currentSeq: number): RunFrame[] | null {
  if (after === null || !Number.isFinite(after) || after < 0 || after > currentSeq) return null;
  if (after === currentSeq) return [];
  const first = ring[0]?.seq;
  if (first === undefined || first > after + 1) return null;
  return ring.filter((f) => f.seq > after);
}

/** Valid client request ids (CONTRACTS §2). */
export const validRequestId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(s);

/** Shopper-facing message for a failed run. */
export function runErrorMessage(e: unknown): string {
  if (e instanceof AssistantLimitError) return e.message;
  if (e instanceof Anthropic.RateLimitError) return "The assistant is busy. Try again in a minute.";
  if (e instanceof Anthropic.BadRequestError && /too long|context|exceed/i.test(e.message))
    return "This chat has more than Neon can read at once. Start a new chat, or send a shorter message.";
  if (e instanceof Anthropic.AuthenticationError) return "The assistant isn't set up correctly.";
  return "Something went wrong. Please try again.";
}

/* ---------- Process registry ---------- */

interface Waiter {
  stepId: string;
  resolve: (outcome: "resumed" | "cancelled" | "expired") => void;
  /** The resume was accepted: from now on the step can't expire (its release may take a moment). */
  accept: () => void;
}

interface LiveRun {
  id: string;
  chatId: string;
  status: RunStatus;
  seq: number;
  userIndex: number;
  partial: PartialEntry;
  pending: PendingStep | null;
  lastResumedStep: string | null;
  expiredSteps: Set<string>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  done: RunDone | null;
  ctrl: AbortController;
  ring: RunFrame[];
  subs: Set<(f: RunFrame) => void>;
  waiter: Waiter | null;
  /** Shopper steps happen one at a time even if two tools ask at once. */
  waitChain: Promise<unknown>;
  /** DB writes for this run, in order. */
  writes: Promise<unknown>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  finished: Promise<void>;
  markFinished: () => void;
}

const registry = processSingleton("assistant-runs", () => ({ runs: new Map<string, LiveRun>(), accepting: new Set<string>() }));

function snapshotOf(r: LiveRun): RunSnapshot {
  return {
    id: r.id,
    chatId: r.chatId,
    status: r.status,
    seq: r.seq,
    userIndex: r.userIndex,
    partial: r.partial,
    pending: r.pending,
    error: r.error,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

type RunRow = NonNullable<Awaited<ReturnType<typeof prisma.assistantRun.findUnique>>>;

function parse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowSnapshot(row: RunRow): RunSnapshot {
  return {
    id: row.id,
    chatId: row.chatId,
    status: row.status as RunStatus,
    seq: row.seq,
    userIndex: row.userIndex,
    partial: { ...emptyPartial(), ...parse<Partial<PartialEntry>>(row.partialJson, {}) },
    pending: parse<PendingStep | null>(row.pendingJson, null),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** A frame before it gets its sequence number. */
type FrameBody = RunFrame extends infer F ? (F extends RunFrame ? Omit<F, "seq"> : never) : never;

function push(r: LiveRun, frame: FrameBody) {
  r.seq++;
  const f = { ...frame, seq: r.seq } as RunFrame;
  r.ring.push(f);
  if (r.ring.length > RING) r.ring.splice(0, r.ring.length - RING);
  for (const s of r.subs) {
    try {
      s(f);
    } catch {
      r.subs.delete(s);
    }
  }
  return f;
}

function write(r: LiveRun, data: Parameters<typeof prisma.assistantRun.update>[0]["data"]) {
  r.writes = r.writes
    .then(() => prisma.assistantRun.update({ where: { id: r.id }, data }))
    .catch((e) => console.error("[runs] save failed:", e instanceof Error ? e.message : e));
  return r.writes;
}

/** Saves the reply so far now (status, pending, partial and seq together). */
function saveNow(r: LiveRun) {
  if (r.flushTimer) clearTimeout(r.flushTimer);
  r.flushTimer = null;
  return write(r, {
    status: r.status,
    seq: r.seq,
    partialJson: JSON.stringify(r.partial),
    pendingJson: r.pending ? JSON.stringify(r.pending) : null,
    lastResumedStep: r.lastResumedStep,
    error: r.error,
    ...(r.startedAt ? { startedAt: new Date(r.startedAt) } : {}),
    ...(r.finishedAt ? { finishedAt: new Date(r.finishedAt) } : {}),
  });
}

function saveSoon(r: LiveRun) {
  if (r.flushTimer) return;
  r.flushTimer = setTimeout(() => {
    r.flushTimer = null;
    void write(r, { seq: r.seq, partialJson: JSON.stringify(r.partial) });
  }, FLUSH_MS);
}

function setStatus(r: LiveRun, status: RunStatus, error: string | null = r.error) {
  r.status = status;
  r.error = error;
  push(r, { type: "status", status, error });
  void saveNow(r);
}

function emitEvent(r: LiveRun, e: LiveEvent) {
  if (!isActive(r.status)) return;
  r.partial = applyEvent(r.partial, e);
  push(r, { type: "event", event: e });
  saveSoon(r);
}

/* ---------- Accepting a run ---------- */

export interface AcceptInput {
  chat: { id: string; title: string; uiJson: string };
  isNew: boolean;
  clientRequestId: string;
  text: string;
  images: Array<{ id: string; mime: string }>;
  docs: DocUpload[];
  voice: boolean;
  editIndex?: number;
  /** Who is sending (for AI usage records and the allowance) and their cart. */
  customerId: string | null;
  visitorId: string;
  cartId: string;
}

export type AcceptResult =
  | { ok: true; accepted: RunAccepted; start: (() => Promise<void>) | null }
  | { ok: false; status: 409 | 503; body: { error: string; activeRun?: RunSnapshot } };

/**
 * Records the run and the shopper's message (provisionally, so it's never lost), and returns a starter for the
 * background work. A repeated clientRequestId returns the same run and no starter.
 */
export async function acceptRun(input: AcceptInput): Promise<AcceptResult> {
  const { chat } = input;
  const existing = await prisma.assistantRun.findUnique({ where: { chatId_clientRequestId: { chatId: chat.id, clientRequestId: input.clientRequestId } } });
  if (existing) return { ok: true, accepted: await acceptedOf(existing, chat, false, true), start: null };
  if (registry.accepting.has(chat.id)) return { ok: false, status: 409, body: { error: "Neon is already answering in this chat." } };
  registry.accepting.add(chat.id);
  try {
    const active = await activeRunFor(chat.id);
    if (active) return { ok: false, status: 409, body: { error: "Neon is still answering in this chat.", activeRun: active } };
    const running = [...registry.runs.values()].filter((r) => isActive(r.status)).length;
    if (running >= MAX_ACTIVE()) return { ok: false, status: 503, body: { error: "Neon is busy right now. Try again in a minute." } };

    const fresh = await prisma.assistantChat.findUnique({ where: { id: chat.id } });
    let ui = parse<UiEntry[]>(fresh?.uiJson ?? chat.uiJson, []);
    const editing = input.editIndex != null && input.editIndex >= 0 && input.editIndex < ui.length && ui[input.editIndex].role === "user";
    const prior = editing ? JSON.stringify(ui) : null;
    let docMeta = input.docs.map(docInfo);
    if (editing) {
      const was = ui[input.editIndex!];
      if (!docMeta.length && was.role === "user" && was.docs?.length) docMeta = was.docs;
      ui = ui.slice(0, input.editIndex);
    }
    const userIndex = ui.length;
    const run = await prisma.assistantRun.create({
      data: { chatId: chat.id, clientRequestId: input.clientRequestId, userIndex, priorUiJson: prior, partialJson: JSON.stringify(emptyPartial()) },
    });
    const user: UiEntry & { role: "user" } = {
      role: "user",
      id: `u_${run.id}`,
      runId: run.id,
      text: input.text,
      ...(input.images.length ? { images: input.images.map((i) => i.id) } : {}),
      ...(docMeta.length ? { docs: docMeta } : {}),
      at: run.createdAt.toISOString(),
    };
    ui.push(user);
    await prisma.assistantChat.update({ where: { id: chat.id }, data: { uiJson: JSON.stringify(ui) } });

    let markFinished = () => {};
    const finished = new Promise<void>((res) => (markFinished = res));
    const live: LiveRun = {
      id: run.id,
      chatId: chat.id,
      status: "queued",
      seq: 0,
      userIndex,
      partial: emptyPartial(),
      pending: null,
      lastResumedStep: null,
      expiredSteps: new Set(),
      error: null,
      createdAt: run.createdAt.toISOString(),
      startedAt: null,
      finishedAt: null,
      done: null,
      ctrl: new AbortController(),
      ring: [],
      subs: new Set(),
      waiter: null,
      waitChain: Promise.resolve(),
      writes: Promise.resolve(),
      flushTimer: null,
      finished,
      markFinished,
    };
    registry.runs.set(run.id, live);
    return {
      ok: true,
      accepted: { run: snapshotOf(live), chat: { id: chat.id, title: chat.title, isNew: input.isNew }, user: user as RunAccepted["user"], duplicate: false },
      start: () => execute(live, input),
    };
  } finally {
    registry.accepting.delete(chat.id);
  }
}

async function acceptedOf(row: RunRow, chat: { id: string; title: string }, isNew: boolean, duplicate: boolean): Promise<RunAccepted> {
  const live = registry.runs.get(row.id);
  const c = await prisma.assistantChat.findUnique({ where: { id: chat.id }, select: { uiJson: true, title: true } });
  const ui = parse<UiEntry[]>(c?.uiJson, []);
  const user = (ui.find((e) => e.role === "user" && e.id === `u_${row.id}`) ?? { role: "user", id: `u_${row.id}`, runId: row.id, text: "" }) as RunAccepted["user"];
  return { run: live ? snapshotOf(live) : rowSnapshot(row), chat: { id: chat.id, title: c?.title ?? chat.title, isNew }, user, duplicate };
}

/* ---------- Executing ---------- */

async function cartCountFor(cartId: string): Promise<number> {
  const [agg, boxes] = await Promise.all([
    prisma.cartItem.aggregate({ where: { cartId }, _sum: { quantity: true } }),
    prisma.cartBox.count({ where: { cartId } }),
  ]);
  return (agg._sum.quantity ?? 0) + boxes;
}

async function execute(r: LiveRun, input: AcceptInput) {
  const who = { customerId: input.customerId, visitorId: input.visitorId };
  r.startedAt = new Date().toISOString();
  setStatus(r, "running");
  // Name new chats (and chats whose first message was edited) while the answer is being written.
  const titling =
    input.isNew || input.editIndex === 0
      ? generateTitle(input.text || (input.docs[0]?.kind === "text" ? input.docs[0].data.slice(0, 500) : (input.docs[0]?.name ?? "")), input.images.length > 0)
          .then(async (title) => {
            await prisma.assistantChat.update({ where: { id: r.chatId }, data: { title } });
            push(r, { type: "title", chatId: r.chatId, title });
          })
          .catch(() => {})
      : null;
  try {
    const out = await chatTurn(
      r.chatId,
      input.cartId,
      { text: input.text, images: input.images, voice: input.voice, editIndex: input.editIndex, docs: input.docs },
      (e) => emitEvent(r, e),
      { runId: r.id, signal: r.ctrl.signal, waitForShopper: (step) => waitForShopper(r, step) },
    );
    // The transcript is saved: record that at once, so a restart in the next few seconds can't misread it.
    void write(r, { status: out.stopped ? "cancelled" : "completed", finishedAt: new Date() });
    await recordAiUse({ ...who, chatId: r.chatId, costMicros: out.costMicros }).catch(() => {});
    if (out.stopped) return await finish(r, "cancelled", null);
    await Promise.race([titling, new Promise((res) => setTimeout(res, 4000))]);
    const after = await aiAllowance(who).catch(() => null);
    r.done = {
      entry: out.entry as RunDone["entry"],
      reaction: out.reaction,
      cartCount: await cartCountFor(input.cartId).catch(() => 0),
      allowance: after ? { remaining: after.remaining, limit: after.limit, subscriber: after.subscriber } : null,
    };
    await finish(r, "completed", null);
  } catch (e) {
    const spent = (e as { costMicros?: unknown })?.costMicros;
    if (typeof spent === "number" && spent > 0) await recordAiUse({ ...who, chatId: r.chatId, costMicros: spent }).catch(() => {});
    if (!(e instanceof AssistantLimitError)) console.error("[runs] run failed:", e instanceof Error ? e.message : e);
    await markUserFailed(r.chatId, r.id).catch(() => {});
    await finish(r, "failed", runErrorMessage(e));
  }
}

async function finish(r: LiveRun, status: RunStatus, error: string | null) {
  if (r.waiter) r.waiter.resolve("cancelled");
  r.pending = null;
  r.finishedAt = new Date().toISOString();
  r.status = status;
  r.error = error;
  if (status === "completed" && r.done) push(r, { type: "done", done: r.done });
  else push(r, { type: "status", status, error });
  await saveNow(r);
  r.markFinished();
  setTimeout(() => {
    if (registry.runs.get(r.id) === r) registry.runs.delete(r.id);
  }, KEEP_FINISHED_MS).unref?.();
}

/** Whether chatTurn already saved this run's reply (completed, or stopped) to the transcript. */
async function savedOutcome(chatId: string, runId: string): Promise<"completed" | "cancelled" | null> {
  const chat = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { uiJson: true } });
  const entry = parse<UiEntry[]>(chat?.uiJson, []).find((e) => e.role === "assistant" && e.id === runId);
  return entry?.role === "assistant" ? (entry.stopped ? "cancelled" : "completed") : null;
}

/** A run that didn't complete: the shopper's message stays, marked failed; an edit gets the old transcript back. */
async function markUserFailed(chatId: string, runId: string) {
  // The reply was saved after all (the run stopped between saving it and recording its status): leave it be.
  if (await savedOutcome(chatId, runId)) return;
  const [chat, run] = await Promise.all([
    prisma.assistantChat.findUnique({ where: { id: chatId }, select: { uiJson: true } }),
    prisma.assistantRun.findUnique({ where: { id: runId }, select: { priorUiJson: true } }),
  ]);
  if (!chat) return;
  if (run?.priorUiJson) {
    await prisma.assistantChat.update({ where: { id: chatId }, data: { uiJson: run.priorUiJson } });
    return;
  }
  const ui = parse<UiEntry[]>(chat.uiJson, []);
  let changed = false;
  for (const e of ui)
    if (e.role === "user" && e.runId === runId && !e.failed) {
      e.failed = true;
      changed = true;
    }
  if (changed) await prisma.assistantChat.update({ where: { id: chatId }, data: { uiJson: JSON.stringify(ui) } });
}

/* ---------- Waiting on the shopper ---------- */

function newStepId() {
  return "st_" + randomBytes(12).toString("base64url").slice(0, 16);
}

function waitForShopper(
  r: LiveRun,
  step: { kind: PendingKind; message: string; browser: { sessionId: string; cardId: string } | null },
): Promise<{ outcome: "resumed" | "cancelled" | "expired"; stepId: string }> {
  const next = r.waitChain.then(() => waitOnce(r, step));
  r.waitChain = next.catch(() => {});
  return next;
}

function waitOnce(
  r: LiveRun,
  step: { kind: PendingKind; message: string; browser: { sessionId: string; cardId: string } | null },
): Promise<{ outcome: "resumed" | "cancelled" | "expired"; stepId: string }> {
  const signal = r.ctrl.signal;
  if (signal.aborted || !isActive(r.status)) return Promise.resolve({ outcome: "cancelled", stepId: "" });
  const now = Date.now();
  const pending: PendingStep = {
    id: newStepId(),
    kind: step.kind,
    message: String(step.message || "Your turn: tap Done when you've finished.").slice(0, 200),
    browser: step.browser,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + WAIT_MS()).toISOString(),
  };
  r.pending = pending;
  r.status = "waiting";
  // The chat shows it as an actionable message ("Approve & next") at the latest point of the conversation.
  const record = { id: pending.id, kind: pending.kind, message: pending.message, createdAt: pending.createdAt };
  emitEvent(r, { type: "approval", record: { ...record, status: "pending" } });
  push(r, { type: "pending", pending });
  push(r, { type: "status", status: "waiting", error: null });
  void saveNow(r);
  return new Promise((resolve) => {
    let settled = false;
    let accepted = false;
    const done = (outcome: "resumed" | "cancelled" | "expired") => {
      if (settled || (accepted && outcome === "expired")) return;
      settled = true;
      if (outcome !== "resumed") emitEvent(r, { type: "approval", record: { ...record, status: outcome, resolvedAt: new Date().toISOString() } });
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (r.waiter?.stepId === pending.id) r.waiter = null;
      if (outcome === "expired" && r.pending?.id === pending.id) {
        r.pending = null;
        r.expiredSteps.add(pending.id);
        push(r, { type: "pending", pending: null });
        setStatus(r, "running");
      }
      resolve({ outcome, stepId: pending.id });
    };
    const onAbort = () => done("cancelled");
    const timer = setTimeout(() => done("expired"), Math.max(0, Date.parse(pending.expiresAt) - Date.now()));
    signal.addEventListener("abort", onAbort, { once: true });
    r.waiter = {
      stepId: pending.id,
      resolve: done,
      accept: () => {
        accepted = true;
        clearTimeout(timer);
      },
    };
  });
}

/* ---------- Commands from the shopper ---------- */

export async function resumeRun(runId: string, stepId: string): Promise<{ status: 200 | 409; body: ResumeResult }> {
  const r = registry.runs.get(runId);
  if (!r) {
    const row = await prisma.assistantRun.findUnique({ where: { id: runId } });
    const snap = row ? rowSnapshot(row) : null;
    if (snap && isActive(snap.status)) {
      // Active in the database but not in this process: it can't continue (it will be marked interrupted).
      return { status: 409, body: { accepted: false, reason: "run_finished", message: INTERRUPTED_ERROR, current: snap } };
    }
    return { status: 409, body: { accepted: false, reason: "run_finished", message: "Neon has already finished this.", current: snap } };
  }
  const d = decideResume(r, stepId);
  if (d.kind === "reject") return { status: 409, body: { accepted: false, reason: d.reason, message: d.message, current: snapshotOf(r) } };
  if (d.kind === "duplicate") return { status: 200, body: { accepted: true, runId, stepId, status: r.status, duplicate: true } };
  // Accept: everything that decides a second, simultaneous resume happens before the first await.
  const step = r.pending!;
  const waiter = r.waiter;
  if (waiter?.stepId === step.id) waiter.accept();
  r.pending = null;
  r.lastResumedStep = step.id;
  r.status = "running";
  emitEvent(r, { type: "approval", record: { id: step.id, kind: step.kind, message: step.message, createdAt: step.createdAt, status: "approved", resolvedAt: new Date().toISOString() } });
  push(r, { type: "pending", pending: null });
  push(r, { type: "status", status: "running", error: null });
  void saveNow(r);
  if (step.browser?.sessionId) await releaseShopperControl(step.browser.sessionId);
  if (waiter?.stepId === step.id) waiter.resolve("resumed");
  return { status: 200, body: { accepted: true, runId, stepId: step.id, status: "running" } };
}

export async function cancelRun(runId: string): Promise<{ cancelled: boolean; run: RunSnapshot } | null> {
  const r = registry.runs.get(runId);
  if (!r) {
    const row = await prisma.assistantRun.findUnique({ where: { id: runId } });
    return row ? { cancelled: false, run: rowSnapshot(row) } : null;
  }
  if (!isActive(r.status)) return { cancelled: false, run: snapshotOf(r) };
  r.ctrl.abort();
  // Wait for the stopped reply to be saved, so the chat can reload it straight away.
  await Promise.race([r.finished, new Promise((res) => setTimeout(res, 8000))]);
  return { cancelled: true, run: snapshotOf(r) };
}

/* ---------- Reading ---------- */

export async function getRun(runId: string): Promise<{ run: RunSnapshot; done: RunDone | null; chatId: string } | null> {
  const r = registry.runs.get(runId);
  if (r) return { run: snapshotOf(r), done: r.done, chatId: r.chatId };
  const row = await prisma.assistantRun.findUnique({ where: { id: runId } });
  if (!row) return null;
  return { run: rowSnapshot(row), done: row.status === "completed" ? await doneFromChat(row) : null, chatId: row.chatId };
}

async function doneFromChat(row: RunRow): Promise<RunDone | null> {
  const chat = await prisma.assistantChat.findUnique({ where: { id: row.chatId }, select: { uiJson: true } });
  const ui = parse<UiEntry[]>(chat?.uiJson, []);
  const entry = ui.find((e) => e.role === "assistant" && e.id === row.id);
  const user = ui.find((e) => e.role === "user" && e.runId === row.id);
  return entry ? { entry: entry as RunDone["entry"], reaction: (user?.role === "user" && user.reaction) || null, cartCount: -1, allowance: null } : null;
}

/** The chat's active run (memory first), if any. */
export async function activeRunFor(chatId: string): Promise<RunSnapshot | null> {
  for (const r of registry.runs.values()) if (r.chatId === chatId && isActive(r.status)) return snapshotOf(r);
  // Active in the database but not running in this process (the one process that runs them): it can't
  // continue, so settle it now instead of blocking the chat until the next restart.
  const rows = await prisma.assistantRun.findMany({ where: { chatId, status: { in: ["queued", "running", "waiting"] } } });
  for (const row of rows) {
    // A run being accepted right now is in the database a moment before it's registered here.
    if (registry.runs.has(row.id) || registry.accepting.has(chatId) || Date.now() - row.createdAt.getTime() < 60_000) return rowSnapshot(row);
    await interrupt(row).catch(() => {});
  }
  return null;
}

export async function lastRunFor(chatId: string): Promise<RunSnapshot | null> {
  const row = await prisma.assistantRun.findFirst({ where: { chatId }, orderBy: { createdAt: "desc" } });
  if (!row) return null;
  const live = registry.runs.get(row.id);
  return live ? snapshotOf(live) : rowSnapshot(row);
}

/**
 * Subscribes to a run's frames after `after`. Returns the frames to send first (a snapshot, or the replay) and
 * whether the run already ended (send them, then close). `onFrame` gets every later frame.
 */
export async function subscribe(
  runId: string,
  after: number | null,
  onFrame: (f: RunFrame) => void,
): Promise<{ initial: RunFrame[]; ended: boolean; unsubscribe: () => void } | null> {
  const r = registry.runs.get(runId);
  if (r) {
    const replay = replayFrom(r.ring, after, r.seq);
    const initial: RunFrame[] = replay ?? [{ type: "snapshot", seq: r.seq, run: snapshotOf(r) }];
    if (!isActive(r.status)) {
      if (!replay && r.done) initial.push({ type: "done", seq: r.seq, done: r.done });
      return { initial, ended: true, unsubscribe: () => {} };
    }
    r.subs.add(onFrame);
    return { initial, ended: false, unsubscribe: () => r.subs.delete(onFrame) };
  }
  const got = await getRun(runId);
  if (!got) return null;
  const initial: RunFrame[] = [{ type: "snapshot", seq: got.run.seq, run: got.run }];
  if (got.done) initial.push({ type: "done", seq: got.run.seq, done: got.done });
  return { initial, ended: true, unsubscribe: () => {} };
}

/** Before deleting a chat: stop its run so it doesn't write to a chat that's gone. */
export async function stopChatRuns(chatId: string) {
  for (const r of registry.runs.values()) if (r.chatId === chatId && isActive(r.status)) await cancelRun(r.id);
}

/* ---------- Boot ---------- */

/** A run active in the database that no process is executing: interrupted, unless its reply was saved already. */
async function interrupt(row: { id: string; chatId: string }) {
  const saved = await savedOutcome(row.chatId, row.id).catch(() => null);
  if (saved) {
    await prisma.assistantRun.update({ where: { id: row.id }, data: { status: saved, error: null, pendingJson: null, finishedAt: new Date() } });
    return;
  }
  await prisma.assistantRun.update({ where: { id: row.id }, data: { status: "interrupted", error: INTERRUPTED_ERROR, pendingJson: null, finishedAt: new Date() } });
  await markUserFailed(row.chatId, row.id).catch(() => {});
}

/** At startup: runs that were active when the process stopped can't continue. Mark them, keep the message. */
export async function recoverInterruptedRuns() {
  const rows = await prisma.assistantRun.findMany({ where: { status: { in: ["queued", "running", "waiting"] } } });
  for (const row of rows) {
    if (registry.runs.has(row.id)) continue;
    await interrupt(row);
  }
  if (rows.length) console.log(`[runs] marked ${rows.length} unfinished run(s) interrupted`);
}

/* ---------- Request helpers shared by the run routes ---------- */

/** Same-origin check for POSTs: a browser always sends Origin on cross-site POSTs. */
export function crossOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host") || "";
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

// Cheap per-IP brake on spend: 30 turns an hour (process memory; one replica).
const hits = processSingleton("assistant-ip-hits", () => new Map<string, number[]>());
export function allowTurn(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= 30) return false;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value!);
  return true;
}
