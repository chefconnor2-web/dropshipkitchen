// The chat's run-stream client against a fake server: frames arrive once and in order whatever the chunking,
// a dropped stream resumes from the last seq without applying anything twice, and resume never throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelRun, createRun, foldRun, newClientRequestId, resumeRun, subscribeRun, type FetchLike, type RunConnection, type RunEndReason } from "../lib/run-client";
import { applyFrame, emptyPartial, formatSse, type RunFrame, type RunSnapshot } from "../lib/run-shared";

const RUN = "run_abc123";

function snap(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUN,
    chatId: "chat_1",
    status: "running",
    seq: 0,
    userIndex: 2,
    partial: emptyPartial(),
    pending: null,
    error: null,
    createdAt: "2026-10-13T10:00:00.000Z",
    startedAt: "2026-10-13T10:00:00.100Z",
    finishedAt: null,
    ...over,
  };
}
const text = (seq: number, delta: string): RunFrame => ({ type: "event", seq, event: { type: "text", delta } });
const done = (seq: number, reply: string): RunFrame => ({
  type: "done",
  seq,
  done: { entry: { role: "assistant", id: RUN, text: reply, cards: [], added: [] }, reaction: null, cartCount: 0, allowance: null },
});

/** Cuts bytes into pieces of the given sizes (cycled), so frames, lines and even UTF-8 characters split anywhere. */
function cut(s: string, sizes: number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(s);
  const out: Uint8Array[] = [];
  for (let i = 0, k = 0; i < bytes.length; k++) {
    const n = sizes[k % sizes.length];
    out.push(bytes.slice(i, i + n));
    i += n;
  }
  return out;
}

/** An event-stream response that plays `chunks`, then closes, errors (a dropped connection) or stays open. */
function stream(chunks: Uint8Array[], end: "close" | "error" | "hang" = "close"): Response {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const ch of chunks) {
        if (cancelled) return;
        c.enqueue(ch);
        await new Promise((r) => setTimeout(r, 0));
      }
      if (cancelled) return;
      if (end === "close") c.close();
      else if (end === "error") c.error(new Error("connection reset"));
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Subscribes with a scripted fetch; resolves when the subscription ends by itself. */
function follow(fetchImpl: FetchLike, extra: { after?: number; backoffMs?: number[] } = {}) {
  const frames: RunFrame[] = [];
  const states: RunConnection[] = [];
  let resolveEnd!: (r: RunEndReason) => void;
  const ended = new Promise<RunEndReason>((r) => (resolveEnd = r));
  const sub = subscribeRun(RUN, {
    after: extra.after,
    fetch: fetchImpl,
    backoffMs: extra.backoffMs ?? [1, 1, 1],
    env: { win: null, doc: null },
    onFrame: (f) => frames.push(f),
    onConnection: (s) => states.push(s),
    onEnd: (r) => resolveEnd(r),
  });
  return { frames, states, ended, sub };
}

test("frames split at awkward boundaries arrive once, in order", async () => {
  const frames: RunFrame[] = [snap(), text(1, "Hé"), text(2, "llo 🔥 "), { type: "event", seq: 3, event: { type: "react", emoji: "👍" } }, text(4, "world"), { type: "status", seq: 5, status: "completed", error: null }, done(6, "Héllo 🔥 world")].map(
    (f) => (f.type === "snapshot" ? { type: "snapshot", seq: 0, run: f as unknown as RunSnapshot } : f),
  ) as RunFrame[];
  frames[0] = { type: "snapshot", seq: 0, run: snap() };
  // A ping comment and CRLF line endings in the middle, as proxies sometimes rewrite them.
  const wire = formatSse(frames[0]) + ": ping\n\n" + frames.slice(1, 3).map(formatSse).join("").replace(/\n/g, "\r\n") + frames.slice(3).map(formatSse).join("");
  const urls: string[] = [];
  const t = follow(async (url) => {
    urls.push(url);
    return stream(cut(wire, [1, 7, 3, 13, 2, 29, 5]));
  });
  assert.equal(await t.ended, "terminal");
  assert.deepEqual(
    t.frames.map((f) => f.seq),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(urls, [`/api/assistant/runs/${RUN}/events`]);
  assert.deepEqual(t.states, ["connecting", "live", "closed"]);
  const final = t.frames.reduce(applyFrame, snap({ seq: -1 }));
  assert.equal(final.partial.text, "Héllo 🔥 world");
  assert.equal(final.partial.reaction, "👍");
  assert.equal(final.status, "completed");
});

test("a dropped stream reconnects with after=<last seq> and nothing is applied twice", async () => {
  const first = [formatSse({ type: "snapshot", seq: 2, run: snap({ seq: 2, partial: { ...emptyPartial(), text: "ab", chars: 2 } }) }), formatSse(text(3, "c")), formatSse(text(4, "d"))].join("");
  // The connection dies in the middle of frame 5.
  const cutOff = formatSse(text(5, "e")).slice(0, 20);
  // The server (being careful) resends 4 and 5; the client must not apply them twice.
  const second = [text(4, "d"), text(5, "e"), text(6, "f"), { type: "status", seq: 7, status: "completed", error: null } as RunFrame, done(8, "abcdef")].map(formatSse).join("");
  const urls: string[] = [];
  const t = follow(async (url) => {
    urls.push(url);
    return urls.length === 1 ? stream(cut(first + cutOff, [11, 4, 17]), "error") : stream(cut(second, [9, 2, 31]));
  }, { after: 2 });
  assert.equal(await t.ended, "terminal");
  assert.deepEqual(urls, [`/api/assistant/runs/${RUN}/events?after=2`, `/api/assistant/runs/${RUN}/events?after=4`]);
  assert.deepEqual(
    t.frames.map((f) => f.seq),
    [2, 3, 4, 5, 6, 7, 8],
  );
  assert.ok(t.states.includes("reconnecting"));
  assert.equal(t.states[t.states.length - 1], "closed");
  // Even replaying every frame (duplicates included) through the reducer gives the same answer.
  const start = snap({ seq: 2, partial: { ...emptyPartial(), text: "ab", chars: 2 } });
  const final = t.frames.reduce(applyFrame, start);
  assert.equal(final.partial.text, "abcdef");
  assert.equal([...t.frames, text(5, "e"), text(6, "f")].reduce(applyFrame, start).partial.text, "abcdef");
  assert.equal(final.status, "completed");
});

test("404 stops: no retries", async () => {
  let calls = 0;
  const t = follow(async () => {
    calls++;
    return jsonRes(404, { error: "Not found" });
  });
  assert.equal(await t.ended, "not_found");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  assert.equal(t.states[t.states.length - 1], "closed");
});

test("a terminal frame stops even when the server keeps the stream open", async () => {
  let calls = 0;
  const t = follow(async () => {
    calls++;
    return stream(cut(formatSse({ type: "snapshot", seq: 3, run: snap({ seq: 3 }) }) + formatSse({ type: "status", seq: 4, status: "cancelled", error: null }), [64]), "hang");
  });
  assert.equal(await t.ended, "terminal");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  assert.deepEqual(
    t.frames.map((f) => f.type),
    ["snapshot", "status"],
  );
});

test("a finished run's stream (snapshot completed, then done) delivers done before stopping", async () => {
  const t = follow(async () => stream(cut(formatSse({ type: "snapshot", seq: 9, run: snap({ seq: 9, status: "completed" }) }) + formatSse(done(9, "hi")).replace("seq\":9", "seq\":10").replace("id: 9", "id: 10"), [5])));
  assert.equal(await t.ended, "terminal");
  assert.deepEqual(
    t.frames.map((f) => f.type),
    ["snapshot", "done"],
  );
});

test("completed but the stream closed before done: the saved reply is fetched once", async () => {
  const urls: string[] = [];
  const t = follow(async (url) => {
    urls.push(url);
    if (url.endsWith("/events")) return stream(cut(formatSse({ type: "status", seq: 1, status: "completed", error: null }), [8]));
    return jsonRes(200, { run: snap({ seq: 1, status: "completed" }), done: (done(2, "saved") as Extract<RunFrame, { type: "done" }>).done });
  });
  assert.equal(await t.ended, "terminal");
  assert.deepEqual(urls, [`/api/assistant/runs/${RUN}/events`, `/api/assistant/runs/${RUN}`]);
  const d = t.frames.find((f) => f.type === "done");
  assert.ok(d && d.type === "done" && d.done.entry.text === "saved");
});

test("after the retries run out: offline, one snapshot, and reconnect() starts again", async () => {
  let failing = true;
  const urls: string[] = [];
  const t = follow(async (url) => {
    urls.push(url);
    if (url === `/api/assistant/runs/${RUN}`) return jsonRes(200, { run: snap({ seq: 5, partial: { ...emptyPartial(), text: "partial" } }), done: null });
    if (failing) throw new TypeError("Load failed");
    return stream(cut([text(6, "!"), { type: "status", seq: 7, status: "failed", error: "Boom" } as RunFrame].map(formatSse).join(""), [10]));
  }, { after: 4, backoffMs: [1, 1] });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(t.states, ["connecting", "reconnecting", "offline"]);
  assert.equal(urls.filter((u) => u.includes("/events")).length, 3); // first try + 2 retries
  assert.equal(t.frames.length, 1);
  assert.equal(t.frames[0].type, "snapshot");
  failing = false;
  t.sub.reconnect();
  assert.equal(await t.ended, "terminal");
  assert.equal(urls[urls.length - 1], `/api/assistant/runs/${RUN}/events?after=5`);
  const final = t.frames.reduce(applyFrame, snap({ seq: 4 }));
  assert.equal(final.partial.text, "partial!");
  assert.equal(final.status, "failed");
  assert.equal(final.error, "Boom");
});

test("close() stops quietly", async () => {
  let ended = false;
  const states: RunConnection[] = [];
  const sub = subscribeRun(RUN, {
    fetch: async () => stream([], "hang"),
    env: { win: null, doc: null },
    onFrame: () => {},
    onConnection: (s) => states.push(s),
    onEnd: () => (ended = true),
  });
  await new Promise((r) => setTimeout(r, 5));
  sub.close();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ended, false);
  assert.equal(states[states.length - 1], "closed");
});

test("online / visible reconnect right away", async () => {
  const listeners = new Map<string, () => void>();
  const target = { addEventListener: (t: string, fn: () => void) => listeners.set(t, fn), removeEventListener: (t: string) => listeners.delete(t) };
  const doc = { ...target, visibilityState: "visible" };
  const urls: string[] = [];
  const sub = subscribeRun(RUN, {
    after: 1,
    fetch: async (url) => {
      urls.push(url);
      throw new TypeError("offline");
    },
    backoffMs: [60_000],
    env: { win: target, doc },
    onFrame: () => {},
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(urls.length, 1); // waiting a minute for the next try…
  listeners.get("online")!();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(urls.length, 2); // …but `online` doesn't wait
  listeners.get("visibilitychange")!();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(urls.length, 3);
  sub.close();
  assert.equal(listeners.size, 0);
});

test("resumeRun returns the server's body for 200 and 409 alike", async () => {
  const current = snap({
    status: "waiting",
    seq: 12,
    pending: { id: "st_newer", kind: "captcha", message: "Solve the puzzle", browser: { sessionId: "s1", cardId: "br_s1" }, createdAt: "", expiresAt: "" },
  });
  const stale = { accepted: false, reason: "stale_step", message: "There's a newer step.", current };
  let sent: unknown = null;
  const r409 = await resumeRun(RUN, "st_old", async (url, init) => {
    assert.equal(url, `/api/assistant/runs/${RUN}/resume`);
    sent = JSON.parse(String(init?.body));
    return jsonRes(409, stale);
  });
  assert.deepEqual(sent, { stepId: "st_old" });
  assert.deepEqual(r409, stale);
  const ok = { accepted: true, runId: RUN, stepId: "st_old", status: "running" };
  assert.deepEqual(await resumeRun(RUN, "st_old", async () => jsonRes(200, ok)), ok);
});

test("resumeRun never throws", async () => {
  const offline = { accepted: false, reason: "not_waiting", message: "Couldn't reach Neon. Try again.", current: null };
  assert.deepEqual(
    await resumeRun(RUN, "st_x", async () => {
      throw new TypeError("Load failed");
    }),
    offline,
  );
  assert.deepEqual(await resumeRun(RUN, "st_x", async () => new Response("<html>Bad gateway</html>", { status: 502 })), offline);
  const gone = await resumeRun(RUN, "st_x", async () => jsonRes(404, { error: "Not found" }));
  assert.equal(gone.accepted, false);
  assert.equal(gone.accepted === false && gone.reason, "run_finished");
});

test("createRun retries a network failure with the same request id, and passes error bodies through", async () => {
  const bodies: string[] = [];
  const accepted = { run: snap(), chat: { id: "chat_1", title: "Hi", isNew: false }, user: { role: "user", id: `u_${RUN}`, text: "hi" }, duplicate: true };
  const r = await createRun(
    { clientRequestId: "abc12345", message: "hi", chatId: "chat_1" },
    async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError("Load failed");
      return jsonRes(200, accepted);
    },
    [1],
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.ok(r.ok && r.accepted.run.id === RUN);
  const busy = await createRun({ clientRequestId: "abc12345", message: "hi" }, async () => jsonRes(409, { error: "Still answering", activeRun: snap() }), []);
  assert.ok(!busy.ok && busy.status === 409 && busy.error === "Still answering" && (busy.body.activeRun as RunSnapshot).id === RUN);
  const down = await createRun({ clientRequestId: "abc12345", message: "hi" }, async () => {
    throw new TypeError("Load failed");
  }, []);
  assert.ok(!down.ok && down.status === 0);
});

test("cancelRun returns the result or null", async () => {
  const res = { cancelled: true, run: snap({ status: "cancelled" }) };
  assert.deepEqual(await cancelRun(RUN, async () => jsonRes(200, res)), res);
  assert.equal(
    await cancelRun(RUN, async () => {
      throw new Error("x");
    }),
    null,
  );
});

test("foldRun: a terminal snapshot ends the run even when its seq lags", () => {
  const live = snap({ seq: 40, partial: { ...emptyPartial(), text: "half" } });
  const restarted = snap({ seq: 31, status: "interrupted", error: "Neon restarted before finishing. Tap retry." });
  assert.equal(applyFrame(live, { type: "snapshot", seq: 31, run: restarted }), live);
  const r = foldRun(live, { type: "snapshot", seq: 31, run: restarted });
  assert.equal(r.status, "interrupted");
  assert.equal(r.error, "Neon restarted before finishing. Tap retry.");
  assert.equal(r.partial.text, "half");
  assert.equal(foldRun(live, text(41, "!")).partial.text, "half!");
});

test("client request ids fit the contract", () => {
  for (let i = 0; i < 20; i++) assert.match(newClientRequestId(), /^[A-Za-z0-9_-]{8,64}$/);
});
