// Runs: the shared reducers, the SSE parser on every chunk split, and the server's pure decisions
// (which resume to accept, what to replay on reconnect).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SseParser, applyEvent, applyFrame, emptyPartial, formatSse, type PendingStep, type RunFrame, type RunSnapshot } from "../lib/run-shared";
import { decideResume, replayFrom, validRequestId } from "../lib/runs";

const step = (id: string, minutes = 10): PendingStep => ({
  id,
  kind: "captcha",
  message: "Solve it",
  browser: { sessionId: "s1", cardId: "br_s1" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
});
const snap = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
  id: "r1",
  chatId: "c1",
  status: "running",
  seq: 0,
  userIndex: 0,
  partial: emptyPartial(),
  pending: null,
  error: null,
  createdAt: new Date().toISOString(),
  startedAt: null,
  finishedAt: null,
  ...over,
});

test("applyEvent: text, breaks, progress steps, items replaced by id, found accumulation", () => {
  let p = emptyPartial();
  p = applyEvent(p, { type: "text", delta: "Hello" });
  p = applyEvent(p, { type: "break" });
  p = applyEvent(p, { type: "break" });
  p = applyEvent(p, { type: "text", delta: "world" });
  assert.equal(p.text, "Hello\n\nworld");
  p = applyEvent(p, { type: "progress", note: "Thinking…" });
  p = applyEvent(p, { type: "progress", note: "Searching" });
  p = applyEvent(p, { type: "progress", note: "Searching" });
  assert.deepEqual(p.steps, ["Thinking…", "Searching"]);
  assert.deepEqual(p.trace, [{ kind: "step", text: "Searching" }]);
  const card = (handoff?: string) => ({ kind: "browser" as const, id: "br_1", session: "1", site: "amazon.ca", ...(handoff ? { handoff } : {}) });
  p = applyEvent(p, { type: "items", group: "Live browser", items: [card()] });
  p = applyEvent(p, { type: "items", group: "Live browser", items: [card("Solve it")] });
  assert.equal(p.items.length, 1);
  assert.equal((p.items[0] as { handoff?: string }).handoff, "Solve it");
  p = applyEvent(p, { type: "found", group: "Battery", cards: [{ pid: "a", title: "A", fromCents: 1 }], done: false });
  p = applyEvent(p, { type: "found", group: "Battery", cards: [{ pid: "a", title: "A", fromCents: 1 }, { pid: "b", title: "B", fromCents: 2 }], done: false });
  assert.deepEqual(p.groups[0].cards.map((c) => c.pid), ["a", "b"]);
  p = applyEvent(p, { type: "found", group: "Battery", cards: [], done: true });
  assert.equal(p.groups[0].done, true);
});

test("applyFrame: old frames ignored, pending means waiting, done completes, snapshots replace", () => {
  let r = snap({ seq: 5 });
  r = applyFrame(r, { type: "event", seq: 4, event: { type: "text", delta: "stale" } });
  assert.equal(r.partial.text, "");
  r = applyFrame(r, { type: "event", seq: 6, event: { type: "text", delta: "hi" } });
  assert.equal(r.partial.text, "hi");
  r = applyFrame(r, { type: "pending", seq: 7, pending: step("st_a") });
  assert.equal(r.status, "waiting");
  r = applyFrame(r, { type: "pending", seq: 8, pending: null });
  assert.equal(r.status, "running");
  const newer = snap({ seq: 20, partial: { ...emptyPartial(), text: "fresh" } });
  r = applyFrame(r, { type: "snapshot", seq: 20, run: newer });
  assert.equal(r.partial.text, "fresh");
  r = applyFrame(r, { type: "status", seq: 21, status: "cancelled", error: null });
  assert.equal(r.status, "cancelled");
  assert.equal(r.pending, null);
});

test("SseParser: every split point of a multi-frame stream, with CRLF, comments and multibyte text", () => {
  const frames: RunFrame[] = [
    { type: "snapshot", seq: 0, run: snap() },
    { type: "event", seq: 1, event: { type: "text", delta: "Héllo 🔥 " } },
    { type: "pending", seq: 2, pending: step("st_x") },
    { type: "event", seq: 3, event: { type: "text", delta: "wörld" } },
  ];
  const wire = formatSse(frames[0]) + ": ping\n\n" + formatSse(frames[1]).replace(/\n/g, "\r\n") + formatSse(frames[2]) + formatSse(frames[3]);
  for (let cut = 0; cut <= wire.length; cut++) {
    const p = new SseParser();
    const got = [...p.feed(wire.slice(0, cut)), ...p.feed(wire.slice(cut))];
    assert.deepEqual(got.map((f) => f.seq), [0, 1, 2, 3], `split at ${cut}`);
    assert.equal(p.lastEventId, "3");
  }
  // Byte-level splits through a TextDecoder in streaming mode keep multibyte characters whole.
  const bytes = new TextEncoder().encode(wire);
  for (const size of [1, 2, 3, 5, 7]) {
    const p = new SseParser();
    const dec = new TextDecoder();
    const got: RunFrame[] = [];
    for (let i = 0; i < bytes.length; i += size) got.push(...p.feed(dec.decode(bytes.slice(i, i + size), { stream: true })));
    got.push(...p.feed(dec.decode()));
    const texts = got.filter((f) => f.type === "event").map((f) => (f.type === "event" && f.event.type === "text" ? f.event.delta : ""));
    assert.deepEqual(texts, ["Héllo 🔥 ", "wörld"], `chunk size ${size}`);
  }
});

test("SseParser skips malformed frames without breaking the stream", () => {
  const p = new SseParser();
  const got = p.feed("data: {not json\n\n" + formatSse({ type: "event", seq: 1, event: { type: "text", delta: "ok" } }));
  assert.deepEqual(got.map((f) => f.seq), [1]);
});

test("decideResume: only the exact pending step is accepted", () => {
  const a = step("st_a");
  assert.deepEqual(decideResume({ status: "waiting", pending: a, lastResumedStep: null }, "st_a"), { kind: "accept" });
  assert.equal((decideResume({ status: "waiting", pending: a, lastResumedStep: null }, "st_b") as { reason: string }).reason, "stale_step");
  assert.equal((decideResume({ status: "running", pending: null, lastResumedStep: null }, "st_a") as { reason: string }).reason, "not_waiting");
  assert.deepEqual(decideResume({ status: "running", pending: null, lastResumedStep: "st_a" }, "st_a"), { kind: "duplicate" });
  // A newer pause after an accepted resume: the old step is stale, not a duplicate.
  assert.equal((decideResume({ status: "waiting", pending: step("st_b"), lastResumedStep: "st_a" }, "st_a") as { reason: string }).reason, "stale_step");
  assert.equal((decideResume({ status: "completed", pending: null, lastResumedStep: "st_a" }, "st_a") as { reason: string }).reason, "run_finished");
  assert.equal((decideResume({ status: "waiting", pending: step("st_c", -1), lastResumedStep: null }, "st_c") as { reason: string }).reason, "expired");
  assert.equal((decideResume({ status: "running", pending: null, lastResumedStep: null, expiredSteps: new Set(["st_d"]) }, "st_d") as { reason: string }).reason, "expired");
});

test("replayFrom: replay only when every missed frame is buffered, else a snapshot", () => {
  const ring: RunFrame[] = [5, 6, 7, 8].map((seq) => ({ type: "event", seq, event: { type: "text", delta: String(seq) } }));
  assert.equal(replayFrom(ring, null, 8), null);
  assert.deepEqual(replayFrom(ring, 6, 8)!.map((f) => f.seq), [7, 8]);
  assert.deepEqual(replayFrom(ring, 4, 8)!.map((f) => f.seq), [5, 6, 7, 8]);
  assert.equal(replayFrom(ring, 2, 8), null, "frames 3-4 were dropped from the ring");
  assert.deepEqual(replayFrom(ring, 8, 8), []);
  assert.equal(replayFrom(ring, 9, 8), null, "a client ahead of the server (restart) gets a snapshot");
});

test("client request ids are checked", () => {
  assert.ok(validRequestId("3f2b6c1e-9d4a-4c1b-8a77-2f1e0c9d8b7a"));
  for (const bad of ["", "short", "x".repeat(65), "has space 123", null, 12345678]) assert.equal(validRequestId(bad), false);
});

test("approval records: opened as pending, then upserted with their outcome", () => {
  let p = emptyPartial();
  const rec = { id: "st_a", kind: "captcha" as const, message: "Robot check", createdAt: "2026-01-01T00:00:00Z" };
  p = applyEvent(p, { type: "approval", record: { ...rec, status: "pending" } });
  p = applyEvent(p, { type: "approval", record: { ...rec, status: "approved", resolvedAt: "2026-01-01T00:01:00Z" } });
  p = applyEvent(p, { type: "approval", record: { ...rec, id: "st_b", status: "pending" } });
  assert.deepEqual(p.approvals.map((a) => [a.id, a.status]), [["st_a", "approved"], ["st_b", "pending"]]);
});
