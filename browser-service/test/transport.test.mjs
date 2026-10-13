// Live-view transport tests: the real service and a real Chromium against a local fixture page.
// Needs CHROME_PATH (defaults to the sandbox's Playwright Chromium). Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import WebSocket from "ws";

const PORT = 8000 + Math.floor(Math.random() * 900);
const FIX_PORT = PORT + 1000;
const SECRET = "testsecret";
const BASE = `http://127.0.0.1:${PORT}`;
const FIX = `http://127.0.0.1:${FIX_PORT}/`;
const H = { "x-browser-secret": SECRET, "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let svc, fixture, sid;

const token = (id, exp = Math.floor(Date.now() / 1000) + 600) => ({ exp, token: crypto.createHmac("sha256", SECRET).update(`live.${id}.${exp}`).digest("base64url") });
const liveUrl = (id, t = token(id)) => `ws://127.0.0.1:${PORT}/live?id=${id}&exp=${t.exp}&token=${t.token}`;
const api = async (path, body, method = "POST") => {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/** A connected live-view client that records everything it receives. */
function client(id, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(liveUrl(id), opts);
    const c = { ws, frames: 0, msgs: [], waiters: [] };
    ws.on("message", (d, bin) => {
      if (bin) c.frames++;
      else c.msgs.push(JSON.parse(String(d)));
      for (const w of c.waiters.splice(0)) w();
    });
    ws.on("open", () => resolve(c));
    ws.on("error", reject);
    c.send = (m) => ws.send(JSON.stringify(m));
    c.until = async (pred, ms = 8000) => {
      const end = Date.now() + ms;
      while (!pred(c)) {
        if (Date.now() > end) throw new Error("timed out; got " + JSON.stringify(c.msgs.slice(-5)));
        await new Promise((r) => {
          c.waiters.push(r);
          setTimeout(r, 100);
        });
      }
    };
  });
}

before(async () => {
  fixture = http
    .createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>Fixture</title><body style="margin:0">
<button id=b style="position:absolute;left:0;top:0;width:100%;height:200px" onclick="document.title='Tapped'">tap me</button>
<input id=i style="position:absolute;left:0;top:260px;width:100%;height:60px" oninput="document.title='typed:'+this.value">
<div style="height:5000px"></div></body>`);
    })
    .listen(FIX_PORT);
  svc = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: String(PORT), BROWSER_SERVICE_SECRET: SECRET, BROWSER_TEST_ALLOW: "^127\\.0\\.0\\.1$", CHROME_PATH: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", MAX_SESSIONS: "3" },
    stdio: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + "/health")).ok) break;
    } catch {}
    await sleep(200);
  }
  const r = await api("/sessions");
  sid = r.body.id;
  const go = await api(`/sessions/${sid}/act`, { actions: [{ type: "goto", url: FIX }] });
  assert.equal(go.status, 200);
});

after(async () => {
  svc?.kill("SIGTERM");
  fixture?.close();
  await sleep(300);
});

test("http needs the secret; sessions no longer hand out a permanent view token", async () => {
  assert.equal((await fetch(BASE + "/sessions", { method: "POST" })).status, 401);
  const r = await api("/sessions");
  assert.ok(r.body.id && !r.body.viewToken);
  await api(`/sessions/${r.body.id}`, undefined, "DELETE");
});

test("bad, expired or missing tokens are refused at upgrade with 401", async () => {
  const tryUrl = (u) => new Promise((res) => { const ws = new WebSocket(u); ws.on("unexpected-response", (_q, r) => res(r.statusCode)); ws.on("open", () => { ws.close(); res(101); }); ws.on("error", () => res("error")); });
  assert.equal(await tryUrl(`ws://127.0.0.1:${PORT}/live?id=${sid}&exp=9999999999&token=nope`), 401);
  assert.equal(await tryUrl(liveUrl(sid, token(sid, Math.floor(Date.now() / 1000) - 5))), 401);
  assert.equal(await tryUrl(`ws://127.0.0.1:${PORT}/live?id=${sid}`), 401);
  const other = token("aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(await tryUrl(`ws://127.0.0.1:${PORT}/live?id=${sid}&exp=${other.exp}&token=${other.token}`), 401);
});

test("a good token streams binary frames and frame size", async () => {
  const c = await client(sid);
  await api(`/sessions/${sid}/act`, { actions: [{ type: "scroll", dy: 300 }, { type: "scroll", dy: -300 }] });
  await c.until((x) => x.frames > 0 && x.msgs.some((m) => m.t === "frame-meta"));
  c.ws.close();
});

test("input without control is refused; invalid input is reported, never silently dropped", async () => {
  const c = await client(sid);
  c.send({ t: "tap", x: 0.5, y: 0.1, n: 1 });
  await c.until((x) => x.msgs.some((m) => m.t === "error" && m.n === 1 && m.code === "not_in_control"));
  c.send({ t: "control", on: true, n: 2 });
  await c.until((x) => x.msgs.some((m) => m.t === "ack" && m.n === 2));
  c.send({ t: "tap", x: NaN, y: 0.1, n: 3 });
  c.send({ t: "tap", x: 2, y: 0.1, n: 4 });
  c.send({ t: "key", key: "Delete", n: 5 });
  await c.until((x) => [3, 4, 5].every((n) => x.msgs.some((m) => m.t === "error" && m.n === n && m.code === "invalid")));
  // A second viewer can't type while the first one has control.
  const v = await client(sid);
  v.send({ t: "type", text: "x", n: 9 });
  await v.until((x) => x.msgs.some((m) => m.t === "error" && m.n === 9 && m.code === "not_in_control"));
  v.ws.close();
  c.send({ t: "control", on: false });
  c.ws.close();
  await sleep(500);
});

test("taps and typing reach the real page in order and are acked; agent steps get 409 meanwhile", async () => {
  const c = await client(sid);
  c.send({ t: "control", on: true, n: 1 });
  await c.until((x) => x.msgs.some((m) => m.t === "ack" && m.n === 1));
  await sleep(1500); // phone mode (reload)
  const busy = await api(`/sessions/${sid}/act`, { actions: [{ type: "wait", ms: 1 }] });
  assert.equal(busy.status, 409);
  const t0 = Date.now();
  c.send({ t: "tap", x: 0.5, y: 0.05, n: 2 });
  await c.until((x) => x.msgs.some((m) => m.t === "ack" && m.n === 2));
  const tapAckMs = Date.now() - t0;
  let st = await api(`/sessions/${sid}/state`, undefined, "GET");
  assert.equal(st.body.title, "Tapped");
  // Focus the input (y ≈ 290px of 844), then type in two messages: order must hold.
  c.send({ t: "tap", x: 0.5, y: 290 / 844, n: 3 });
  c.send({ t: "type", text: "hel", n: 4 });
  c.send({ t: "type", text: "lo", n: 5 });
  c.send({ t: "key", key: "Backspace", n: 6 });
  await c.until((x) => x.msgs.some((m) => m.t === "ack" && m.n === 6));
  assert.ok(c.msgs.some((m) => m.t === "focus" && m.editing === true));
  st = await api(`/sessions/${sid}/state`, undefined, "GET");
  assert.equal(st.body.title, "typed:hell");
  console.log(`# tap→ack ${tapAckMs} ms`);
  c.send({ t: "control", on: false });
  c.ws.close();
  await sleep(800);
});

test("a burst of scrolls is merged and bounded; the queue never overflows silently", async () => {
  const c = await client(sid);
  c.send({ t: "control", on: true, n: 1 });
  await c.until((x) => x.msgs.some((m) => m.t === "ack" && m.n === 1));
  for (let i = 0; i < 200; i++) c.send({ t: "scroll", dy: 10, n: 100 + i });
  await c.until((x) => x.msgs.filter((m) => (m.t === "ack" || m.t === "error") && m.n >= 100).length === 200, 20000);
  const errors = c.msgs.filter((m) => m.t === "error" && m.n >= 100);
  assert.ok(errors.every((e) => e.code === "busy"), "only busy errors");
  const y = await api(`/sessions/${sid}/act`, { actions: [] }).catch(() => null);
  void y;
  c.send({ t: "control", on: false });
  c.ws.close();
  await sleep(800);
});

test("a paused viewer resumes on current frames (delivery bounding is unit-tested in frames.test.mjs)", async () => {
  const c = await client(sid);
  await c.until((x) => x.frames > 0);
  c.ws._socket.pause();
  for (let i = 0; i < 6; i++) await api(`/sessions/${sid}/act`, { actions: [{ type: "scroll", dy: i % 2 ? -400 : 400 }] });
  c.ws._socket.resume();
  const before = c.frames;
  await api(`/sessions/${sid}/act`, { actions: [{ type: "scroll", dy: 200 }] });
  await c.until((x) => x.frames > before);
  c.ws.close();
});

test("release gives control back to Neon and tells every viewer", async () => {
  const c = await client(sid);
  c.send({ t: "control", on: true, n: 1 });
  await c.until((x) => x.msgs.some((m) => m.t === "ack" && m.n === 1));
  const r = await api(`/sessions/${sid}/release`);
  assert.equal(r.status, 200);
  await c.until((x) => x.msgs.some((m) => m.t === "control" && m.on === false && m.by === "server"));
  const ok = await api(`/sessions/${sid}/act`, { actions: [{ type: "wait", ms: 1 }] });
  assert.equal(ok.status, 200);
  c.send({ t: "tap", x: 0.5, y: 0.5, n: 2 });
  await c.until((x) => x.msgs.some((m) => m.t === "error" && m.n === 2 && m.code === "not_in_control"));
  c.ws.close();
});

test("control is released when the controlling phone disconnects", async () => {
  const c = await client(sid);
  c.send({ t: "control", on: true, n: 1 });
  await c.until((x) => x.msgs.some((m) => m.t === "ack" && m.n === 1));
  c.ws.terminate();
  await sleep(1500);
  const ok = await api(`/sessions/${sid}/act`, { actions: [{ type: "wait", ms: 1 }] });
  assert.equal(ok.status, 200);
});

test("pages outside Amazon and private addresses are blocked", async () => {
  const r = await api(`/sessions/${sid}/act`, { actions: [{ type: "goto", url: "https://example.com/" }] });
  assert.equal(r.status, 400);
  const m = await api(`/sessions/${sid}/act`, { actions: [{ type: "goto", url: "http://169.254.169.254/latest/meta-data" }] });
  assert.equal(m.status, 400);
});

test("DELETE ends the session and closes viewers with a reason", async () => {
  const r = await api("/sessions");
  const id = r.body.id;
  const c = await client(id);
  await api(`/sessions/${id}`, undefined, "DELETE");
  await c.until((x) => x.msgs.some((m) => m.t === "ended"));
  assert.equal((await api(`/sessions/${id}/state`, undefined, "GET")).status, 404);
});
