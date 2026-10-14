// The Chit MCP's in-chat view (MCP Apps, ui://chit/cards.html): one small page that Claude and ChatGPT show in a
// sandboxed frame under a tool's reply. It draws the tool result's cards (structuredContent.cards, see
// lib/mcp-cards.ts) and opens Book / Check out links in the customer's browser through the host (app.openLink).
// The MCP Apps client library is inlined (the frame can't load scripts from elsewhere).

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const VIEW_URI = "ui://chit/cards.html";

let html: string | null = null;

/** The MCP Apps library as a classic script that sets window.McpApps (its ES module exports, renamed). */
function appLibrary(): string {
  const src = readFileSync(join(process.cwd(), "node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js"), "utf8");
  const m = /export\s*\{([^}]*)\};?\s*$/.exec(src);
  if (!m) throw new Error("Unexpected MCP Apps bundle format");
  const pairs = m[1]
    .split(",")
    .map((p) => p.trim().split(/\s+as\s+/))
    .filter((p) => p[0])
    .map(([local, exported]) => `${JSON.stringify(exported ?? local)}:${local}`);
  return `(function(){${src.slice(0, m.index)};window.McpApps={${pairs.join(",")}};})();`;
}

const CSS = `
:root{--bg:transparent;--card:#fff;--ink:#16161d;--muted:#6b6b7b;--line:#e7e6f0;--accent:#5B4BF5;--accent-ink:#fff;--chip:#f3f2fb;--ok:#127a4b;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--card:#1d1d24;--ink:#f1f1f5;--muted:#a3a3b2;--line:#2e2e38;--chip:#2a2935;--ok:#4fd197}}
:root[data-theme=dark]{--card:#1d1d24;--ink:#f1f1f5;--muted:#a3a3b2;--line:#2e2e38;--chip:#2a2935;--ok:#4fd197}
:root[data-theme=light]{--card:#fff;--ink:#16161d;--muted:#6b6b7b;--line:#e7e6f0;--chip:#f3f2fb;--ok:#127a4b}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
#root{display:flex;flex-direction:column;gap:10px;padding:2px}
.brand{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.02em}
.brand i{width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.t{font-weight:650;font-size:15px}.s{color:var(--muted);font-size:13px}
.p{text-align:right;white-space:nowrap}.p b{font-size:17px;display:block}.p span{color:var(--muted);font-size:11px}
.l{font-size:13px;font-variant-numeric:tabular-nums}
.badges{display:flex;flex-wrap:wrap;gap:6px}.badge{background:var(--chip);border-radius:999px;padding:2px 8px;font-size:12px}
.opts{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}
.opt{flex:0 0 auto;border:1px solid var(--line);border-radius:10px;padding:6px 10px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;min-width:110px}
.opt b{display:block;font-size:13px}.opt span{font-size:11px;color:var(--muted)}.opt[aria-pressed=true]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
button.a{border:0;border-radius:10px;padding:8px 14px;font:600 13px/1 inherit;font-family:inherit;cursor:pointer;background:var(--chip);color:var(--ink)}
button.a.primary{background:var(--accent);color:var(--accent-ink)}
.foot{font-size:11px;color:var(--muted)}
.empty{color:var(--muted);font-size:13px;padding:6px 2px}
.live{position:relative;border-radius:10px;overflow:hidden;background:#0d0d12;border:1px solid var(--line)}
.live canvas{display:block;width:100%;height:auto;min-height:160px;touch-action:none}
.live.ctl canvas{cursor:pointer;outline:2px solid var(--accent);outline-offset:-2px}
.lv-st{position:absolute;left:8px;top:8px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;border-radius:999px;padding:3px 8px;display:flex;gap:6px;align-items:center}
.lv-st i{width:6px;height:6px;border-radius:50%;background:#e5484d;display:inline-block}
.lv-toast{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;font-size:12px;border-radius:8px;padding:5px 10px}
.lv-type{display:flex;gap:6px;flex-wrap:wrap}
.lv-type input{flex:1 1 160px;min-width:0;border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit;background:var(--card);color:var(--ink)}
`;

const SCRIPT = `
const { App } = window.McpApps;
const root = document.getElementById("root");
const app = new App({ name: "Chit", version: "1.0.0" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const open = (url) => app.openLink({ url }).catch(() => window.open(url, "_blank", "noopener"));

function theme(ctx) { if (ctx && ctx.theme) document.documentElement.dataset.theme = ctx.theme; }

let lives = [];

// Neon's live browser: frames over a WebSocket to the browser service (address minted per connection by the
// app-only browser_live tool); after Take over, taps, scrolls and typing go back over the same socket.
function startLive(live, el) {
  const canvas = el.querySelector("canvas"), st = el.querySelector("[data-st]"), box = el.querySelector("[data-live]");
  const take = el.querySelector("[data-take]"), bar = el.querySelector("[data-typebar]"), input = el.querySelector("[data-text]");
  let ws = null, gone = false, tries = 0, inControl = false, n = 0, drawing = false, pending = null;
  const send = (m) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ ...m, n: ++n })); return true; } return false; };
  const toast = (t) => { const d = document.createElement("div"); d.className = "lv-toast"; d.textContent = t; box.appendChild(d); setTimeout(() => d.remove(), 2400); };
  const setControl = (on) => { inControl = on; box.classList.toggle("ctl", on); bar.hidden = !on; take.textContent = on ? "Give back to Neon" : "Take over"; };
  async function draw(blob) {
    if (drawing) { pending = blob; return; }
    drawing = true;
    try {
      const bmp = await createImageBitmap(blob);
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
      canvas.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close();
    } catch {}
    drawing = false;
    if (pending) { const b = pending; pending = null; draw(b); }
  }
  async function connect() {
    if (gone) return;
    let url = null;
    try {
      const r = await app.callServerTool({ name: "browser_live", arguments: { chat_id: live.chatId, session: live.session } });
      url = !r.isError && r.structuredContent && r.structuredContent.url;
    } catch {}
    if (!url) { st.textContent = "Browser closed"; take.disabled = true; return; }
    ws = new WebSocket(url);
    ws.binaryType = "blob";
    ws.onopen = () => { tries = 0; st.textContent = "Live" + (live.site ? " · " + live.site : ""); if (inControl) send({ t: "control", on: true, w: 390, h: 740 }); };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return draw(e.data);
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "status") { try { if (m.url) st.textContent = "Live · " + new URL(m.url).hostname.replace(/^www\\./, ""); } catch {} }
      else if (m.t === "control" && m.on === false) setControl(false);
      else if (m.t === "error" && m.message && m.code !== "dropped") toast(m.message);
    };
    ws.onclose = () => { ws = null; if (gone) return; if (++tries > 6) { st.textContent = "Connection lost. Tap to reconnect."; return; } st.textContent = "Reconnecting…"; setTimeout(connect, Math.min(8000, 500 * 2 ** tries)); };
  }
  box.addEventListener("click", (e) => {
    if (!ws) { tries = 0; return connect(); }
    if (!inControl) return;
    const r = canvas.getBoundingClientRect();
    send({ t: "tap", x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) });
  });
  box.addEventListener("wheel", (e) => { if (!inControl) return; e.preventDefault(); send({ t: "scroll", dy: e.deltaY }); }, { passive: false });
  let touchY = null;
  box.addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  box.addEventListener("touchmove", (e) => { if (!inControl || touchY == null) return; e.preventDefault(); const y = e.touches[0].clientY; send({ t: "scroll", dy: (touchY - y) * 2 }); touchY = y; }, { passive: false });
  take.addEventListener("click", () => {
    if (!inControl) { if (send({ t: "control", on: true, w: 390, h: 740 })) setControl(true); }
    else { send({ t: "control", on: false }); setControl(false); }
  });
  el.querySelector("[data-send]").addEventListener("click", () => { if (input.value) { send({ t: "type", text: input.value.slice(0, 2000) }); input.value = ""; } });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (input.value) send({ t: "type", text: input.value.slice(0, 2000) }); input.value = ""; send({ t: "key", key: "Enter" }); } });
  el.querySelector("[data-key]").addEventListener("click", () => send({ t: "key", key: "Enter" }));
  el.querySelector("[data-back]").addEventListener("click", () => send({ t: "back" }));
  const done = el.querySelector("[data-done]");
  if (done) done.addEventListener("click", async () => {
    done.disabled = true;
    if (inControl) { send({ t: "control", on: false }); setControl(false); }
    try {
      const r = await app.callServerTool({ name: "browser_done", arguments: { run_id: live.runId, step_id: live.stepId } });
      toast(r.isError ? "Neon had already moved on." : "Neon is carrying on.");
      if (!r.isError) app.sendMessage({ role: "user", content: [{ type: "text", text: "I'm done in Neon's browser." }] }).catch(() => {});
    } catch { done.disabled = false; }
  });
  connect();
  return () => { gone = true; if (ws) ws.close(); };
}

function render(data) {
  lives.forEach((stop) => stop());
  lives = [];
  const cards = (data && Array.isArray(data.cards)) ? data.cards : [];
  if (!cards.length) { root.innerHTML = data && data.note ? '<div class="empty">' + esc(data.note) + '</div>' : ""; return; }
  root.innerHTML = '<div class="brand"><i></i>Chit' + (data.title ? ' · ' + esc(data.title) : '') + '</div>' + cards.map((c, n) => {
    const opts = (c.options || []);
    return '<div class="card" data-n="' + n + '">' +
      '<div class="top"><div><div class="t">' + esc(c.title) + '</div>' + (c.subtitle ? '<div class="s">' + esc(c.subtitle) + '</div>' : '') + '</div>' +
      (c.price ? '<div class="p"><b data-price>' + esc(c.price) + '</b>' + (c.priceNote ? '<span>' + esc(c.priceNote) + '</span>' : '') + '</div>' : '') + '</div>' +
      (c.lines || []).filter(Boolean).map((l) => '<div class="l">' + esc(l) + '</div>').join('') +
      (c.badges && c.badges.length ? '<div class="badges">' + c.badges.map((b) => '<span class="badge">' + esc(b) + '</span>').join('') + '</div>' : '') +
      (opts.length ? '<div class="opts">' + opts.map((o, i) => '<button class="opt" data-opt="' + i + '" aria-pressed="' + (o.price === c.price && i === opts.findIndex((x) => x.price === c.price)) + '"><b>' + esc(o.label) + ' · ' + esc(o.price) + '</b><span>' + esc(o.detail) + '</span></button>').join('') + '</div>' : '') +
      (c.live ? '<div class="live" data-live><canvas width="390" height="300"></canvas><div class="lv-st"><i></i><span data-st>Connecting…</span></div></div>' +
        '<div class="lv-type" data-typebar hidden><input data-text placeholder="Type into the page" autocomplete="off"><button class="a" data-send>Send</button><button class="a" data-key="Enter">⏎</button><button class="a" data-back>Back</button></div>' +
        '<div class="acts"><button class="a primary" data-take>Take over</button>' + (c.live.stepId ? '<button class="a" data-done>I&rsquo;m done</button>' : '') + '</div>' : '') +
      ((c.actions || []).length ? '<div class="acts">' + c.actions.map((a, i) => '<button class="a' + (a.primary ? ' primary' : '') + '" data-act="' + i + '">' + esc(a.label) + '</button>').join('') + '</div>' : '') +
      '</div>';
  }).join('') + (data.footer ? '<div class="foot">' + esc(data.footer) + '</div>' : '');
  root.querySelectorAll(".card").forEach((el) => {
    const c = cards[Number(el.dataset.n)];
    if (c.live) lives.push(startLive(c.live, el));
    let bookUrl = null;
    el.querySelectorAll("[data-opt]").forEach((b) => b.addEventListener("click", () => {
      const o = c.options[Number(b.dataset.opt)];
      bookUrl = o.url;
      el.querySelectorAll("[data-opt]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      const p = el.querySelector("[data-price]"); if (p) p.textContent = o.price;
    }));
    el.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
      const a = c.actions[Number(b.dataset.act)];
      open(a.primary && bookUrl ? bookUrl : a.url);
    }));
  });
}

app.ontoolresult = (r) => render(r && r.structuredContent);
app.onhostcontextchanged = (ctx) => theme(ctx);
app.connect().then(() => theme(app.getHostContext())).catch(() => {});
`;

/** The view's HTML (built once per process). */
export function viewHtml(): string {
  if (html) return html;
  html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chit</title><style>${CSS}</style></head><body><div id="root"></div><script>${appLibrary()}</script><script>${SCRIPT}</script></body></html>`;
  return html;
}
