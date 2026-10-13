// Chit browser service. One Chromium, one incognito context per chat: Neon drives it through the HTTP API
// (Amazon search, add to cart, view cart, taps and typing), and the shopper watches it live in the chat over a
// WebSocket and can take over to solve a captcha, sign in and check out.
//
// HTTP (header x-browser-secret: BROWSER_SERVICE_SECRET):
//   POST   /sessions                       → { id, viewToken }
//   DELETE /sessions/:id
//   POST   /sessions/:id/act               { actions: [...] } → page state + screenshot
//   POST   /sessions/:id/amazon/search     { domain, query }
//   POST   /sessions/:id/amazon/add        { domain, asin, quantity }
//   POST   /sessions/:id/amazon/cart       { domain }
//   GET    /health
// WebSocket /live?id=…&token=… : binary JPEG frames out; JSON status out; JSON input in (only while the
// shopper has control).
//
// Top-level navigation is limited to Amazon, so the browser can't be pointed at anything else (including this
// service's private network). Nothing the shopper types is logged.

import http from "node:http";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8080;
const SECRET = process.env.BROWSER_SERVICE_SECRET || "";
const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 3;
const IDLE_MS = (Number(process.env.IDLE_MINUTES) || 15) * 60_000;
const VIEW = { width: 390, height: 780 };
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
// Pages the browser may open. Images, scripts and styles can come from anywhere public.
const NAV_ALLOWED = /(^|\.)(amazon\.(com|ca)|amazonpay\.com|amazon\.dev|media-amazon\.com|ssl-images-amazon\.com)$/i;
// Tests only: extra hosts the browser may open (e.g. a local fixture server). Never set in production.
const TEST_ALLOW = process.env.BROWSER_TEST_ALLOW ? new RegExp(process.env.BROWSER_TEST_ALLOW) : null;
const navOk = (host) => NAV_ALLOWED.test(host) || !!TEST_ALLOW?.test(host);
const PRIVATE_HOST = /^(localhost|.*\.internal|.*\.local|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

if (!SECRET) console.warn("[browser] BROWSER_SERVICE_SECRET is not set: every request will be refused.");

let browser = null;
async function getBrowser() {
  if (browser?.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled", "--lang=en-US"],
  });
  browser.on("disconnected", () => {
    browser = null;
    for (const s of sessions.values()) endSession(s, "The browser restarted.");
  });
  return browser;
}

/** @type {Map<string, any>} */
const sessions = new Map();
const viewToken = (id) => crypto.createHmac("sha256", SECRET).update(`view:${id}`).digest("hex").slice(0, 40);
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function createSession() {
  for (const s of sessions.values()) if (Date.now() - s.lastUsed > IDLE_MS) await endSession(s, "Closed after being idle.");
  if (sessions.size >= MAX_SESSIONS) {
    // Make room by closing the session idle longest, unless the shopper is using it.
    const oldest = [...sessions.values()].filter((s) => !s.userControl).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!oldest) throw Object.assign(new Error("All browsers are busy. Try again in a few minutes."), { status: 503 });
    await endSession(oldest, "Closed to make room for another shopper.");
  }
  const b = await getBrowser();
  const ctx = await b.createBrowserContext();
  const page = await ctx.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ ...VIEW, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    const host = hostOf(url);
    if (/^(data|blob):/i.test(url)) return req.continue();
    // Video and audio never matter for shopping; skipping them speeds pages up.
    if (req.resourceType() === "media") return req.abort("blockedbyclient");
    if (!/^https?:/i.test(url) || (PRIVATE_HOST.test(host) && !TEST_ALLOW?.test(host))) return req.abort("blockedbyclient");
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !navOk(host)) return req.abort("blockedbyclient");
    req.continue();
  });
  // Popups open in the same tab (they can't be shown otherwise).
  page.on("popup", async (p) => {
    const url = p.url();
    await p.close().catch(() => {});
    if (navOk(hostOf(url))) page.goto(url).catch(() => {});
  });

  const id = crypto.randomBytes(12).toString("hex");
  const s = { id, ctx, page, clients: new Set(), lastFrame: null, lastUsed: Date.now(), userControl: false, busy: false };
  const cdp = await page.createCDPSession();
  s.cdp = cdp;
  cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    // The frame covers the visible page; taps from the live view are mapped with its real size.
    if (metadata?.deviceWidth) s.frame = { w: metadata.deviceWidth, h: metadata.deviceHeight };
    const jpeg = Buffer.from(data, "base64");
    s.lastFrame = jpeg;
    for (const ws of s.clients) if (ws.readyState === 1 && ws.bufferedAmount < 64 * 1024) ws.send(jpeg, { binary: true });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEW.width * 2, maxHeight: VIEW.height * 2, everyNthFrame: 1 });
  page.on("framenavigated", (f) => f === page.mainFrame() && status(s));
  sessions.set(id, s);
  return s;
}

async function endSession(s, reason = "Closed.") {
  if (!sessions.has(s.id)) return;
  sessions.delete(s.id);
  for (const ws of s.clients) {
    try {
      ws.send(JSON.stringify({ t: "ended", reason }));
      ws.close();
    } catch {}
  }
  await s.ctx.close().catch(() => {});
}

async function status(s) {
  if (!s.clients.size) return;
  const needs = await needsShopper(s.page).catch(() => null);
  const msg = JSON.stringify({ t: "status", url: s.page.url(), title: await s.page.title().catch(() => ""), control: s.userControl, needs });
  for (const ws of s.clients) if (ws.readyState === 1) ws.send(msg);
}

async function isCaptcha(page) {
  if (/validateCaptcha/i.test(page.url())) return true;
  const title = await page.title().catch(() => "");
  if (/robot check|sorry! something went wrong/i.test(title)) return true;
  if (await page.$('form[action*="validateCaptcha"], #captchacharacters').catch(() => null)) return true;
  // Amazon's softer robot check: "Click the button below to continue shopping".
  const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 2000)).catch(() => "");
  return /click the button below to continue shopping|enter the characters you see|make sure you're not a robot/i.test(text);
}

/** What on the page only the shopper can get past, if anything (said to them in the chat). */
async function needsShopper(page) {
  if (await isCaptcha(page)) return "Amazon wants to check you're not a robot. Tap Take over and get past it.";
  if (/\/ap\/(signin|mfa|cvf)|\/ax\/claim/i.test(page.url())) return "Amazon is asking you to sign in. Tap Take over to sign in yourself.";
  return null;
}

/** Where the page is now, and a picture of it for Neon to look at. */
async function snapshot(s, extra = {}) {
  const shot = await s.page.screenshot({ type: "jpeg", quality: 55, captureBeyondViewport: false, clip: { x: 0, y: 0, ...VIEW, scale: 1 } }).catch(() => null);
  const needs = await needsShopper(s.page);
  return {
    url: s.page.url(),
    title: await s.page.title().catch(() => ""),
    captcha: !!needs && !/sign in/.test(needs),
    signIn: !!needs && /sign in/.test(needs),
    needsShopper: needs,
    screenshot: shot ? Buffer.from(shot).toString("base64") : null,
    ...extra,
  };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function goto(s, url) {
  if (!navOk(hostOf(url))) throw Object.assign(new Error("Only Amazon pages can be opened."), { status: 400 });
  await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
  await pause(250);
}

async function runAction(s, a) {
  const page = s.page;
  switch (a?.type) {
    case "goto":
      return goto(s, String(a.url));
    case "tap": {
      const x = Math.max(0, Math.min(VIEW.width, Number(a.x)));
      const y = Math.max(0, Math.min(VIEW.height, Number(a.y)));
      await page.touchscreen.tap(x, y);
      return pause(700);
    }
    case "type":
      return page.keyboard.type(String(a.text ?? "").slice(0, 500), { delay: 25 });
    case "key": {
      const key = String(a.key);
      if (!["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp"].includes(key)) throw Object.assign(new Error("Unsupported key."), { status: 400 });
      await page.keyboard.press(key);
      return pause(500);
    }
    case "scroll":
      await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: "instant" }), Math.max(-3000, Math.min(3000, Number(a.dy) || 600)));
      return pause(400);
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      return pause(500);
    case "wait":
      return pause(Math.max(0, Math.min(5000, Number(a.ms) || 1000)));
    default:
      throw Object.assign(new Error(`Unknown action ${a?.type}`), { status: 400 });
  }
}

const AMAZON = new Set(["amazon.com", "amazon.ca"]);
const domainOf = (d) => (AMAZON.has(String(d)) ? String(d) : "amazon.com");

async function amazonSearch(s, domain, query) {
  await goto(s, `https://www.${domainOf(domain)}/s?k=${encodeURIComponent(String(query).slice(0, 200))}`);
  if (await isCaptcha(s.page)) return snapshot(s, { results: [] });
  await s.page.waitForSelector('[data-component-type="s-search-result"], [data-asin]', { timeout: 8000 }).catch(() => null);
  const results = await s.page.$$eval('[data-component-type="s-search-result"]', (els) =>
    els.slice(0, 12).flatMap((el) => {
      const asin = el.getAttribute("data-asin");
      if (!asin || asin.length !== 10) return [];
      const title = (el.querySelector("h2 span") || el.querySelector("h2"))?.textContent?.trim() || "";
      if (!title) return [];
      const price = el.querySelector(".a-price .a-offscreen")?.textContent?.trim() || null;
      const rating = el.querySelector(".a-icon-alt")?.textContent?.trim() || null;
      const reviews = el.querySelector('[aria-label$="ratings"], .s-underline-text')?.textContent?.trim() || null;
      const sponsored = /sponsored/i.test(el.textContent || "");
      const img = el.querySelector("img.s-image")?.getAttribute("src") || null;
      const prime = !!el.querySelector(".a-icon-prime, [aria-label*='Prime']");
      return [{ asin, title: title.slice(0, 200), price, rating, reviews, sponsored, prime, image: img }];
    }),
  );
  return snapshot(s, { results });
}

async function amazonAdd(s, domain, asin, quantity) {
  if (!/^[A-Z0-9]{10}$/i.test(String(asin))) throw Object.assign(new Error("That isn't an Amazon product ID (ASIN)."), { status: 400 });
  const page = s.page;
  await goto(s, `https://www.${domainOf(domain)}/dp/${asin}`);
  if (await isCaptcha(page)) return snapshot(s, { added: false, reason: "captcha" });
  const title = await page.$eval("#productTitle, #title", (el) => el.textContent.trim()).catch(() => "");
  const price = await page.$eval(".a-price .a-offscreen, #corePrice_feature_div .a-offscreen", (el) => el.textContent.trim()).catch(() => null);
  const qty = Math.max(1, Math.min(30, Number(quantity) || 1));
  let appliedQty = 1;
  if (qty > 1) {
    const options = await page.$$eval('select[name="quantity"] option', (els) => els.map((o) => Number(o.value)).filter(Number.isFinite)).catch(() => []);
    if (options.length) {
      const pick = Math.max(...options.filter((n) => n <= qty), Math.min(...options));
      await page.select('select[name="quantity"]', String(pick)).catch(() => {});
      appliedQty = pick;
    }
  }
  const button = await page
    .waitForSelector('#add-to-cart-button, #add-to-cart-button-ubb, input[name="submit.add-to-cart"], input[name="submit.addToCart"]', { visible: true, timeout: 5000 })
    .catch(() => null);
  if (!button) return snapshot(s, { added: false, title, price, reason: "No Add to Cart button on this page (it may need an option chosen, or only be sold through other sellers)." });
  const before = await page.$eval("#nav-cart-count, .nav-cart-count", (el) => el.textContent.trim()).catch(() => "");
  await button.tap().catch(() => button.click());
  let added = false;
  for (let i = 0; i < 12 && !added; i++) {
    await pause(350);
    // Decline add-on offers (protection plans) that some products show.
    const noThanks = await page.$('#attachSiNoCoverage, #siNoCoverage-announce, [aria-labelledby="attachSiNoCoverage-announce"]').catch(() => null);
    if (noThanks) await noThanks.tap().catch(() => {});
    const now = await page.$eval("#nav-cart-count, .nav-cart-count", (el) => el.textContent.trim()).catch(() => "");
    const confirm = await page.$("#NATC_SMART_WAGON_CONF_MSG_SUCCESS, #sw-atc-details-single-container, #attachDisplayAddBaseAlert, #huc-v2-order-row-confirm-text, #sw-atc-confirmation").catch(() => null);
    added = !!confirm || (!!now && now !== before);
  }
  return snapshot(s, { added, title, price, quantity: appliedQty, requestedQuantity: qty });
}

async function amazonCart(s, domain) {
  await goto(s, `https://www.${domainOf(domain)}/gp/cart/view.html`);
  if (await isCaptcha(s.page)) return snapshot(s, { items: [] });
  const data = await s.page.evaluate(() => {
    const items = [...document.querySelectorAll("[data-asin][data-itemtype='active'], .sc-list-item[data-asin]")].map((el) => ({
      asin: el.getAttribute("data-asin"),
      title: (el.querySelector(".sc-product-title, .a-truncate-full, .sc-grid-item-product-title")?.textContent || "").trim().slice(0, 200),
      quantity: Number(el.getAttribute("data-quantity")) || Number(el.querySelector("[name='quantity'], .a-dropdown-prompt")?.textContent) || null,
      price: (el.querySelector(".sc-product-price, .a-price .a-offscreen")?.textContent || "").trim() || null,
    }));
    const subtotal = (document.querySelector("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox, .sc-subtotal .a-price .a-offscreen")?.textContent || "").trim() || null;
    return { items: items.filter((i) => i.asin), subtotal };
  });
  return snapshot(s, data);
}

// ---------- HTTP ----------

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw Object.assign(new Error("Request too large."), { status: 413 });
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** One agent request at a time per session, never while the shopper has control. */
async function withSession(id, fn) {
  const s = sessions.get(id);
  if (!s) throw Object.assign(new Error("That browser session has closed."), { status: 404 });
  if (s.userControl) throw Object.assign(new Error("The shopper has control of the browser right now."), { status: 409 });
  if (s.busy) throw Object.assign(new Error("The browser is still busy with the last step."), { status: 409 });
  s.busy = true;
  s.lastUsed = Date.now();
  try {
    return await fn(s);
  } finally {
    s.busy = false;
    s.lastUsed = Date.now();
    status(s).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") return send(res, 200, { ok: true, sessions: sessions.size, max: MAX_SESSIONS });
  const given = String(req.headers["x-browser-secret"] || "");
  if (!SECRET || !safeEq(given, SECRET)) return send(res, 401, { error: "Unauthorized" });
  try {
    const m = url.pathname.match(/^\/sessions(?:\/([a-f0-9]{24}))?(\/.*)?$/);
    if (!m) return send(res, 404, { error: "Not found" });
    const [, id, rest = ""] = m;
    if (!id && req.method === "POST") {
      const s = await createSession();
      return send(res, 200, { id: s.id, viewToken: viewToken(s.id) });
    }
    if (id && !rest && req.method === "DELETE") {
      const s = sessions.get(id);
      if (s) await endSession(s);
      return send(res, 200, { ok: true });
    }
    if (id && req.method === "POST") {
      const body = await readJson(req);
      if (rest === "/act") {
        const actions = Array.isArray(body.actions) ? body.actions.slice(0, 12) : [];
        return send(res, 200, await withSession(id, async (s) => {
          for (const a of actions) await runAction(s, a);
          return snapshot(s);
        }));
      }
      if (rest === "/amazon/search") return send(res, 200, await withSession(id, (s) => amazonSearch(s, body.domain, body.query ?? "")));
      if (rest === "/amazon/add") return send(res, 200, await withSession(id, (s) => amazonAdd(s, body.domain, body.asin, body.quantity)));
      if (rest === "/amazon/cart") return send(res, 200, await withSession(id, (s) => amazonCart(s, body.domain)));
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : "The browser hit a problem." });
    if (!e.status) console.error("[browser]", e);
  }
});

// ---------- Live view ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  const id = url.searchParams.get("id") || "";
  const token = url.searchParams.get("token") || "";
  const s = url.pathname === "/live" ? sessions.get(id) : null;
  if (!s || !SECRET || !safeEq(token.padEnd(40).slice(0, 40), viewToken(id))) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    s.clients.add(ws);
    s.lastUsed = Date.now();
    if (s.lastFrame) ws.send(s.lastFrame, { binary: true });
    status(s).catch(() => {});
    ws.on("close", () => s.clients.delete(ws));
    ws.on("message", async (raw, isBinary) => {
      if (isBinary || !sessions.has(s.id)) return;
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      s.lastUsed = Date.now();
      try {
        if (m.t === "control") {
          s.userControl = !!m.on;
          return status(s);
        }
        if (!s.userControl) return;
        if (m.t === "tap") {
          const f = s.frame || { w: VIEW.width, h: VIEW.height };
          const x = Math.max(0, Math.min(1, Number(m.x))) * f.w;
          const y = Math.max(0, Math.min(1, Number(m.y))) * f.h;
          await s.page.touchscreen.tap(x, y);
        }
        else if (m.t === "type") await s.page.keyboard.type(String(m.text ?? "").slice(0, 500));
        else if (m.t === "key") await runAction(s, { type: "key", key: m.key });
        else if (m.t === "scroll") await runAction(s, { type: "scroll", dy: m.dy });
        else if (m.t === "back") await runAction(s, { type: "back" });
      } catch {
        // Shopper input that fails (a blocked page, a stale element) is ignored; the next frame shows the result.
      }
    });
  });
});

setInterval(() => {
  for (const s of sessions.values()) if (Date.now() - s.lastUsed > IDLE_MS && !s.clients.size) endSession(s, "Closed after being idle.");
}, 60_000).unref();

server.listen(PORT, () => console.log(`[browser] listening on ${PORT}, up to ${MAX_SESSIONS} sessions`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
  for (const s of sessions.values()) await endSession(s, "The browser service is restarting.");
  await browser?.close().catch(() => {});
  process.exit(0);
});
