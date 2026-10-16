// Reading a shared link (POST /read): the real service and Chromium against a local page that builds its
// content with a script after load, the way Google AI Mode streams an answer. Private addresses are refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const PORT = 9000 + Math.floor(Math.random() * 800);
const FIX_PORT = PORT + 50;
const SECRET = "testsecret";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "x-browser-secret": SECRET, "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let svc, fixture;

before(async () => {
  fixture = http
    .createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>AI Mode answer</title><body><div id=a>Loading…</div><div style="height:2400px"></div>
<script>setTimeout(()=>{document.getElementById('a').innerHTML='<h1>Silverado EV parts</h1><ul><li>EVE MB31 314Ah cells</li><li>JK 16S BMS</li></ul>'},800)</script></body>`);
    })
    .listen(FIX_PORT);
  svc = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: String(PORT), BROWSER_SERVICE_SECRET: SECRET, BROWSER_TEST_ALLOW: "^127\\.0\\.0\\.1$", CHROME_PATH: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" },
    stdio: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + "/health")).ok) break;
    } catch {}
    await sleep(200);
  }
});

after(async () => {
  svc?.kill("SIGTERM");
  fixture?.close();
});

const read = async (url, secret = SECRET) => {
  const r = await fetch(BASE + "/read", { method: "POST", headers: { ...H, "x-browser-secret": secret }, body: JSON.stringify({ url }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test("reads a page that renders with scripts: text and screenshots", async () => {
  const r = await read(`http://127.0.0.1:${FIX_PORT}/share/abc`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.title, "AI Mode answer");
  assert.match(r.body.text, /Silverado EV parts/);
  assert.match(r.body.text, /JK 16S BMS/);
  assert.ok(r.body.screenshots.length >= 2 && r.body.screenshots.length <= 3, `${r.body.screenshots.length} shots`);
  assert.ok(Buffer.from(r.body.screenshots[0], "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "JPEG");
});

test("private addresses and bad links are refused", async () => {
  for (const u of ["http://10.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://localhost:8080/health", "file:///etc/passwd", "not a url"]) {
    const r = await read(u);
    assert.equal(r.status, 400, `${u}: ${JSON.stringify(r.body)}`);
  }
});

test("needs the service secret", async () => {
  const r = await read(`http://127.0.0.1:${FIX_PORT}/`, "wrong");
  assert.equal(r.status, 401);
});
