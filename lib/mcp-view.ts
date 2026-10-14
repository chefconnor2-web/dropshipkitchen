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
`;

const SCRIPT = `
const { App } = window.McpApps;
const root = document.getElementById("root");
const app = new App({ name: "Chit", version: "1.0.0" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const open = (url) => app.openLink({ url }).catch(() => window.open(url, "_blank", "noopener"));

function theme(ctx) { if (ctx && ctx.theme) document.documentElement.dataset.theme = ctx.theme; }

function render(data) {
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
      ((c.actions || []).length ? '<div class="acts">' + c.actions.map((a, i) => '<button class="a' + (a.primary ? ' primary' : '') + '" data-act="' + i + '">' + esc(a.label) + '</button>').join('') + '</div>' : '') +
      '</div>';
  }).join('') + (data.footer ? '<div class="foot">' + esc(data.footer) + '</div>' : '');
  root.querySelectorAll(".card").forEach((el) => {
    const c = cards[Number(el.dataset.n)];
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
