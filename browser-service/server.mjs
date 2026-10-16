// Chit browser service. One Chromium, one incognito context per chat: Neon drives it through the HTTP API
// (Amazon search, add to cart, view cart, taps and typing), and the shopper watches it live in the chat over a
// WebSocket and can take over to solve a captcha, sign in and check out.
//
// HTTP (header x-browser-secret: BROWSER_SERVICE_SECRET):
//   POST   /sessions                       → { id }
//   DELETE /sessions/:id                   end it (clients get {t:"ended"})
//   GET    /sessions/:id/state             page state + screenshot
//   POST   /sessions/:id/release           shopper control off (the run resumed), back to desktop
//   POST   /sessions/:id/act               { actions: [...] } → page state + screenshot
//   POST   /sessions/:id/amazon/search     { domain, query }
//   POST   /sessions/:id/amazon/add        { domain, asin, quantity }
//   POST   /sessions/:id/amazon/cart       { domain }
//   POST   /read                           { url } → { url, title, text, screenshots[] } (read-only, any public page)
//   GET    /health
// WebSocket /live?id=…&exp=…&token=… (token = HMAC of "live.<id>.<exp>", minted by the storefront for the
// chat's owner, valid until exp): binary JPEG frames out, newest first (a slow phone skips frames, never
// replays old ones); JSON status out; JSON input in, only from the socket that has control, run one at a
// time in order and acked. Protocol: docs/frontier-port/CONTRACTS.md §8 in the storefront repo.
//
// Top-level navigation is limited to Amazon, so the browser can't be pointed at anything else (including this
// service's private network). Nothing the shopper types is logged.

import http from "node:http";
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import puppeteer from "puppeteer-core";
import { WebSocketServer } from "ws";
import { deliver as deliverFrame, stopDelivery } from "./frames.mjs";
import { runPool } from "./pool.mjs";
import { SMART, settle, smartAction } from "./forms.mjs";
import { runBrowserTool } from "./browser-tool.mjs";

const PORT = Number(process.env.PORT) || 8080;
const SECRET = process.env.BROWSER_SERVICE_SECRET || "";
const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 3;
const IDLE_MS = (Number(process.env.IDLE_MINUTES) || 15) * 60_000;
// Per live-view client: never queue more than this in the socket before sending another frame.
const FRAME_QUEUE_BYTES = Number(process.env.FRAME_QUEUE_BYTES) || 48 * 1024;
const QUALITY = Math.max(20, Math.min(90, Number(process.env.SCREENCAST_QUALITY) || 60));
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const INPUT_QUEUE = 64;
// A session nobody is watching and Neon isn't using is closed after this (Chrome is the memory hog: the
// service has 1 GB, and each Amazon tab takes 250-450 MB).
const UNWATCHED_MS = (Number(process.env.UNWATCHED_MINUTES) || 3) * 60_000;
// One input step may take this long before it's reported as failed (a hung page never blocks the queue).
const STEP_MS = 25_000;
const log = (...a) => console.log("[browser]", ...a);
const BATCH_MAX = 20;
const KEYS = ["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
// Same browser as workflow-agent-cart's shopping agent (desktop Chrome, 1280×800), which Amazon treats as a
// normal shopper; a mobile emulation got a different Amazon and stalled at Add to Cart.
const VIEW = { width: 1280, height: 800 };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// While the shopper drives from their phone, the same tab shows Amazon's phone site (same cookies, so the cart
// and sign-in carry over); handing back returns it to the desktop browser Neon uses.
const PHONE_VIEW = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

async function startCast(s) {
  const phone = s.mode === "phone";
  await s.cdp.send("Page.stopScreencast").catch(() => {});
  await s.cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: QUALITY,
    maxWidth: phone ? phoneView(s).width * 2 : VIEW.width,
    maxHeight: phone ? phoneView(s).height * 2 : VIEW.height,
    everyNthFrame: 1,
  });
}

/**
 * Switches the tab between the desktop browser (Neon) and the phone site (the shopper driving). Done with the
 * DevTools emulation calls directly, never page.setViewport: that reloads the page whenever the mobile/touch
 * emulation changes, which would throw away what the shopper just did. Puppeteer's own viewport stays the
 * desktop one throughout (screenshots use s.mode).
 */
async function setMode(s, mode) {
  if (s.mode === mode) return;
  s.mode = mode;
  const page = s.page;
  const phone = mode === "phone";
  const v = phone ? phoneView(s) : VIEW;
  await page.setUserAgent(phone ? PHONE_UA : UA);
  await s.cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor ?? 1, mobile: phone });
  await s.cdp.send("Emulation.setTouchEmulationEnabled", phone ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await startCast(s);
  // Going to the phone site: reload so Amazon serves its phone layout (not after a form post, which a reload
  // would resend, nor on sign-in or robot-check pages). Back to desktop: no reload; Neon's next step navigates.
  if (phone && /^https:\/\//.test(page.url()) && !/\/ap\/|\/ax\/|validateCaptcha/i.test(page.url()) && !(await cameFromForm(s)))
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
}
/** The phone viewport: the shopper's own full-screen browser area when their phone told us, else 390×844. */
function phoneView(s) {
  const w = Math.round(Math.max(320, Math.min(600, s.screen?.w || PHONE_VIEW.width)));
  const h = Math.round(Math.max(400, Math.min(1100, s.screen?.h || PHONE_VIEW.height)));
  return { ...PHONE_VIEW, width: w, height: h };
}

/** The shopper's screen changed size (rotation, keyboard): resize the phone page without a reload. */
async function resizePhone(s) {
  if (s.mode !== "phone") return;
  const v = phoneView(s);
  await s.cdp.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor, mobile: true });
  await startCast(s);
}

/** Was the current page reached by submitting a form? (Reloading it would send the form again.) */
async function cameFromForm(s) {
  const h = await s.cdp.send("Page.getNavigationHistory").catch(() => null);
  const entry = h?.entries?.[h.currentIndex];
  return entry?.transitionType === "form_submit";
}

// Pages the browser may open: Amazon, and Discover Cars (rental car search). Images, scripts and styles can
// come from anywhere public.
const NAV_ALLOWED = /(^|\.)(amazon\.(com|ca)|amazonpay\.com|amazon\.dev|media-amazon\.com|ssl-images-amazon\.com|discovercars\.com)$/i;
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
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      // Memory: one renderer per site instead of per frame, fewer background services, small JS heaps.
      "--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,BackForwardCache,OptimizationHints",
      "--renderer-process-limit=2",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--mute-audio",
      "--js-flags=--max-old-space-size=256",
      // Internal and private names never resolve (the pages can't reach this service's private network).
      "--host-resolver-rules=MAP *.internal ~NOTFOUND, MAP *.railway.internal ~NOTFOUND, MAP *.local ~NOTFOUND" + (TEST_ALLOW ? "" : ", MAP localhost ~NOTFOUND"),
    ],
  });
  browser.on("disconnected", () => {
    browser = null;
    for (const s of sessions.values()) endSession(s, "The browser restarted.");
  });
  return browser;
}

/** @type {Map<string, any>} */
const sessions = new Map();
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
/** Live-view tokens: minted by the storefront for the chat's owner, expiring (CONTRACTS.md §3). */
function liveTokenOk(id, exp, token) {
  if (!SECRET || !/^\d{9,11}$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEq(token, crypto.createHmac("sha256", SECRET).update(`live.${id}.${exp}`).digest("base64url"));
}

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
    const oldest = [...sessions.values()].filter((s) => !s.userControl && !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!oldest) throw Object.assign(new Error("All browsers are busy. Try again in a few minutes."), { status: 503 });
    await endSession(oldest, "Closed to make room for another shopper.");
  }
  const b = await getBrowser();
  const ctx = await b.createBrowserContext();
  try {
    return await setUpSession(ctx);
  } catch (e) {
    // Nothing half-made is left behind.
    await ctx.close().catch(() => {});
    throw e;
  }
}

async function setUpSession(ctx) {
  const page = await ctx.newPage();
  await page.setUserAgent(UA);
  await page.setViewport(VIEW);
  // No request interception (it slows every request down); instead the main page is pulled back if it ever
  // leaves Amazon, e.g. from a link the shopper taps.
  let lastOk = "about:blank";
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    const url = f.url();
    const host = hostOf(url);
    if (url === "about:blank" || navOk(host)) {
      lastOk = url;
      return;
    }
    // Chrome's own error page (a load that failed or was blocked) stays put; pulling back from it could loop.
    if (!/^https?:/i.test(url)) return;
    page.goto(PRIVATE_HOST.test(host) ? "about:blank" : lastOk).catch(() => {});
  });
  // Popups open in the same tab (they can't be shown otherwise).
  page.on("popup", async (p) => {
    const url = p.url();
    await p.close().catch(() => {});
    if (navOk(hostOf(url))) page.goto(url).catch(() => {});
  });

  const id = crypto.randomBytes(12).toString("hex");
  // urls: product links from the latest searches, by ASIN (opened exactly as the search result linked them).
  // controller: the one socket allowed to send input while the shopper has control. queue: their input, run in order.
  const s = { id, ctx, page, clients: new Set(), lastFrame: null, lastUsed: Date.now(), userControl: false, controller: null, busy: false, urls: new Map(), mode: "desktop", queue: [], draining: false };
  page.on("error", () => {
    log("session", s.id.slice(0, 6), "page crashed");
    endSession(s, "The page crashed. Ask Neon to try again.");
  });
  // A native alert/confirm would freeze every step: dismiss it.
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  const cdp = await page.createCDPSession();
  s.cdp = cdp;
  cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    // The frame covers the visible page; taps from the live view are mapped with its real size.
    if (metadata?.deviceWidth && (s.frame?.w !== metadata.deviceWidth || s.frame?.h !== metadata.deviceHeight)) {
      s.frame = { w: metadata.deviceWidth, h: metadata.deviceHeight };
      broadcast(s, { t: "frame-meta", w: s.frame.w, h: s.frame.h });
    }
    const jpeg = Buffer.from(data, "base64");
    s.lastFrame = jpeg;
    for (const ws of s.clients) deliverFrame(ws, jpeg, FRAME_QUEUE_BYTES);
  });
  // Video and audio streams are the heaviest thing on Amazon pages and nobody needs them here.
  await cdp.send("Network.enable").catch(() => {});
  await cdp.send("Network.setBlockedURLs", { urls: ["*.mp4*", "*.m3u8*", "*.webm*", "*.m4s*", "*.mpd*", "*/videos/*.ts*"] }).catch(() => {});
  if (process.env.NAV_INTERCEPT !== "off") {
    // Check every page load (main page and frames) before it's requested: the main page may only be Amazon,
    // and nothing may load from a private address. Only documents are intercepted, so images, scripts and
    // Amazon's own requests are untouched.
    cdp.on("Fetch.requestPaused", ({ requestId, request, frameId }) => {
      const host = hostOf(request.url);
      const main = frameId === (page.mainFrame()._id ?? page.target()._targetId);
      const blocked = !navOk(host) && (PRIVATE_HOST.test(host) || main);
      cdp.send(blocked ? "Fetch.failRequest" : "Fetch.continueRequest", blocked ? { requestId, errorReason: "BlockedByClient" } : { requestId }).catch(() => {});
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
  }
  await startCast(s);
  page.on("framenavigated", (f) => f === page.mainFrame() && status(s));
  sessions.set(id, s);
  log("session", id.slice(0, 6), "opened;", sessions.size, "open");
  return s;
}

async function endSession(s, reason = "Closed.") {
  if (!sessions.has(s.id)) return;
  sessions.delete(s.id);
  log("session", s.id.slice(0, 6), "closed:", reason, sessions.size, "open");
  for (const it of s.queue.splice(0)) it.resolve?.();
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
  broadcast(s, { t: "status", url: s.page.url(), title: await s.page.title().catch(() => ""), control: s.userControl, mode: s.mode, needs });
}

function reply(ws, m) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(m));
}
function broadcast(s, m) {
  const msg = JSON.stringify(m);
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
  if (await isCaptcha(page)) return "Amazon wants to check you're not a robot. Get past it, then tap Approve & next.";
  if (/\/ap\/(signin|mfa|cvf)|\/ax\/claim/i.test(page.url())) return "Amazon wants you to sign in. Sign in yourself (Neon never sees it), then tap Done.";
  // Other sites' robot checks (Cloudflare and similar).
  if (!/(^|\.)amazon\./i.test(hostOf(page.url()))) {
    const title = await page.title().catch(() => "");
    const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 1500)).catch(() => "");
    if (/just a moment|attention required|access denied/i.test(title) || /verify you are (a )?human|press (and|&) hold|are you a robot/i.test(text))
      return "The site wants to check you're not a robot. Get past it, then tap Approve & next.";
  }
  return null;
}

/** Where the page is now, and a picture of it for Neon to look at. */
async function snapshot(s, extra = {}, page = s.page, withShot = true) {
  const vp = s.mode === "phone" ? PHONE_VIEW : VIEW;
  // Helper tabs report facts only: the shopper (and Neon) watch the main tab. Steps in a row can skip the picture.
  const shot = page === s.page && withShot ? await page.screenshot({ type: "jpeg", quality: 55, captureBeyondViewport: false, clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale: 1 } }).catch(() => null) : null;
  const needs = await needsShopper(page);
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    captcha: !!needs && !/sign in/.test(needs),
    signIn: !!needs && /sign in/.test(needs),
    needsShopper: needs,
    screenshot: shot ? Buffer.from(shot).toString("base64") : null,
    ...extra,
  };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function goto(s, url, page = s.page) {
  if (!navOk(hostOf(url))) throw Object.assign(new Error("Only Amazon and Discover Cars pages can be opened."), { status: 400 });
  // Amazon gets the long wait (its first load is slow); other sites fail fast so Neon can fall back.
  const amazon = /(^|\.)amazon\./i.test(hostOf(url));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: amazon ? 30000 : 25000 });
  } catch (e) {
    log("goto failed:", hostOf(url), e?.name || "Error");
    // Stop the half-loaded page, so the next look at it (a screenshot, the title) answers at once.
    if (page === s.page) await s.cdp?.send("Page.stopLoading").catch(() => {});
    else await page.evaluate(() => window.stop()).catch(() => {});
    throw e;
  }
}

/**
 * Opens a link the way the shopper's own browser would (a fresh, signed-out context: no cookies from the live
 * session) and says where it lands: the payment step, an earlier booking step, a confirmation, or somewhere
 * else. Only the kind and a booking number go back, never page text (it can hold the shopper's details).
 */
async function probeUrl(url) {
  if (!navOk(hostOf(url))) throw Object.assign(new Error("Only Amazon and Discover Cars pages can be opened."), { status: 400 });
  const b = await getBrowser();
  const ctx = await b.createBrowserContext();
  // A light, bounded look: no images, fonts or media, and never more than 12 s (it must not hold up the live
  // browser the shopper is using).
  const cap = setTimeout(() => void ctx.close().catch(() => {}), 12000);
  try {
    const page = await ctx.newPage();
    await page.setUserAgent(UA);
    await page.setViewport(VIEW);
    await page.setRequestInterception(true);
    page.on("request", (r) => (["image", "font", "media"].includes(r.resourceType()) ? r.abort() : r.continue()).catch(() => {}));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    // Booking pages render after load; give them a moment, then read.
    await settle(page, 1500);
    const r = await page.evaluate(() => {
      const t = (document.body?.innerText || "").replace(/\s+/g, " ");
      const u = location.href;
      const fields = [...document.querySelectorAll("input, iframe")].map((e) => `${e.getAttribute("name") || ""} ${e.getAttribute("autocomplete") || ""} ${e.getAttribute("title") || ""} ${e.getAttribute("src") || ""}`).join(" ");
      // A booking number: an upper-case code with digits, just after "booking"/"confirmation"/"reservation".
      const at = t.search(/booking|confirmation|reservation/i);
      const num = at < 0 ? null : (/\b(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,}\b/.exec(t.slice(at, at + 160))?.[0] ?? null);
      let kind = "other";
      if (/booking (is )?confirmed|confirmation number|your booking (number|reference)|reservation (is )?confirmed|thank you for (your )?(booking|order)|booking successful/i.test(t) || /confirm(ation|ed)|thank-?you|success/i.test(new URL(u).pathname)) kind = "confirmed";
      else if (/cc-number|cardnumber|card-number|cc-exp|cvc|stripe|adyen|braintree|checkout\.com|payment/i.test(fields) || /\/(payment|checkout|pay)\b/i.test(new URL(u).pathname) || /card number|payment details|pay now|cardholder/i.test(t)) kind = "payment";
      else if (/driver details|main driver|first name/i.test(t) || /\/offer\/driver/i.test(u)) kind = "driver";
      else if (/\/offer\//i.test(u)) kind = "offer";
      else if (/\/search\//i.test(u)) kind = "search";
      return { url: u, kind, number: kind === "confirmed" ? num : null };
    });
    return { ...r, title: await page.title().catch(() => "") };
  } finally {
    clearTimeout(cap);
    await ctx.close().catch(() => {});
  }
}

/* ---------- Reading a shared link: any public page, read-only ---------- */

// A link the shopper shares (a Google AI Mode answer, an article, a list): opened in its own fresh, signed-out
// context with no input at all, fully rendered, then read as text plus a few screenshots. Every document load
// (the page, its redirects and frames) must resolve to a public address, so a link can't reach this service's
// private network. Never more than READ_MS, and at most READ_MAX at once so the live browser stays responsive.
const READ_MS = 35_000;
const READ_MAX = 2;
let reading = 0;

const privateIp = (ip) => {
  if (net.isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
};
const publicHostCache = new Map();
async function publicHost(host) {
  const h = host.replace(/^\[|\]$/g, "");
  if (TEST_ALLOW?.test(h)) return true;
  if (!h || PRIVATE_HOST.test(h)) return false;
  if (net.isIP(h)) return !privateIp(h);
  if (publicHostCache.has(h)) return publicHostCache.get(h);
  const ok = await lookup(h, { all: true }).then((as) => as.length > 0 && !as.some((x) => privateIp(x.address)), () => false);
  if (publicHostCache.size > 500) publicHostCache.clear();
  publicHostCache.set(h, ok);
  return ok;
}

async function readPage(raw) {
  let target;
  try {
    target = new URL(String(raw));
  } catch {
    throw Object.assign(new Error("That isn't a link."), { status: 400 });
  }
  if (!/^https?:$/.test(target.protocol) || !(await publicHost(target.hostname))) throw Object.assign(new Error("Only public web pages can be read."), { status: 400 });
  if (reading >= READ_MAX) throw Object.assign(new Error("Reading another link right now. Try again in a moment."), { status: 429 });
  reading++;
  const b = await getBrowser();
  const ctx = await b.createBrowserContext();
  const cap = setTimeout(() => void ctx.close().catch(() => {}), READ_MS);
  try {
    const page = await ctx.newPage();
    await page.setUserAgent(UA);
    await page.setViewport(VIEW);
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      (async () => {
        if (r.resourceType() === "media") return r.abort();
        let host = "";
        try {
          host = new URL(r.url()).hostname;
        } catch {
          return r.abort();
        }
        // Documents (the page, redirects, frames) are checked by DNS; other requests by name.
        const ok = r.resourceType() === "document" ? await publicHost(host) : !PRIVATE_HOST.test(host);
        return ok ? r.continue() : r.abort();
      })().catch(() => {});
    });
    await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
    // Pages that build themselves with scripts (AI Mode streams its answer): wait for the network to go quiet.
    await page.waitForNetworkIdle({ idleTime: 1200, timeout: 12000 }).catch(() => {});
    await settle(page, 1500);
    const text = await page.evaluate(() => (document.body?.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()).catch(() => "");
    const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => VIEW.height);
    // Up to three screens, top to bottom, so tables and cards the text loses are still seen.
    const screenshots = [];
    for (let y = 0, i = 0; i < 3 && y < height; i++, y += VIEW.height) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y).catch(() => {});
      await pause(250);
      const shot = await page.screenshot({ type: "jpeg", quality: 60, captureBeyondViewport: false }).catch(() => null);
      if (shot) screenshots.push(Buffer.from(shot).toString("base64"));
    }
    return { url: page.url(), title: await page.title().catch(() => ""), text: text.slice(0, 40000), truncated: text.length > 40000, screenshots };
  } finally {
    clearTimeout(cap);
    reading--;
    await ctx.close().catch(() => {});
  }
}

async function runAction(s, a) {
  const page = s.page;
  // Smart form actions (fill / select / date / click_text): the page finds the field itself. forms.mjs.
  if (SMART.has(a?.type)) return smartAction(page, a);
  switch (a?.type) {
    case "goto":
      return goto(s, String(a.url));
    case "tap": {
      if (!Number.isFinite(Number(a.x)) || !Number.isFinite(Number(a.y))) throw Object.assign(new Error("Bad tap."), { status: 400 });
      const x = Math.max(0, Math.min(VIEW.width, Number(a.x)));
      const y = Math.max(0, Math.min(VIEW.height, Number(a.y)));
      await page.mouse.click(x, y, { delay: 20 });
      // Done as soon as the page settles (most taps change nothing on the network), not after a fixed wait.
      await pause(60);
      return settle(page, 600);
    }
    case "type":
      return page.keyboard.type(String(a.text ?? "").slice(0, 500), { delay: 6 });
    case "key": {
      const key = String(a.key);
      if (!["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp"].includes(key)) throw Object.assign(new Error("Unsupported key."), { status: 400 });
      await page.keyboard.press(key);
      await pause(40);
      return settle(page, 500);
    }
    case "scroll": {
      const dy = a.dy == null ? 600 : Number(a.dy);
      if (!Number.isFinite(dy)) throw Object.assign(new Error("Bad scroll."), { status: 400 });
      if (dy) await page.evaluate((d) => window.scrollBy({ top: d, behavior: "instant" }), Math.max(-3000, Math.min(3000, dy)));
      return pause(150);
    }
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      return settle(page, 500);
    case "wait":
      return pause(Math.max(0, Math.min(5000, Number(a.ms) || 1000)));
    default:
      throw Object.assign(new Error(`Unknown action ${a?.type}`), { status: 400 });
  }
}

const AMAZON = new Set(["amazon.com", "amazon.ca"]);
const domainOf = (d) => (AMAZON.has(String(d)) ? String(d) : "amazon.com");

const isProductUrl = (url) => /^https?:\/\/(www\.)?amazon\.(com|ca)\/.*(\/dp\/|\/gp\/product\/)[A-Z0-9]{10}/i.test(url);

// The next two follow workflow-agent-cart's searchAmazon and addToCart step for step.
async function amazonSearch(s, domain, query, page = s.page) {
  const base = `https://www.${domainOf(domain)}`;
  await goto(s, `${base}/s?k=${encodeURIComponent(String(query).slice(0, 200))}`, page);
  if (await isCaptcha(page)) return snapshot(s, { results: [] }, page);
  await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 10000 }).catch(() => null);
  for (const y of [200, 500, 900, 1300]) {
    await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "smooth" }), y);
    await pause(350);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await pause(250);
  const results = await page.$$eval(
    '[data-component-type="s-search-result"]',
    (items, base) => {
      const out = [];
      for (const item of items.slice(0, 8)) {
        const el = item;
        const asin = el.getAttribute("data-asin");
        if (!asin || asin.length !== 10) continue;
        const titleEl =
          el.querySelector("h2 span") ??
          el.querySelector("h2 a span") ??
          el.querySelector("h2") ??
          el.querySelector(".a-size-base-plus") ??
          el.querySelector(".a-size-medium.a-color-base.a-text-normal");
        const name = titleEl?.textContent?.trim() ?? "";
        if (!name || /^amazon's choice/i.test(name)) continue;
        const productHref = Array.from(el.querySelectorAll("a[href]"))
          .map((a) => a.getAttribute("href") ?? "")
          .find((h) => /\/dp\/|\/gp\/product\//i.test(h));
        const url = productHref ? (productHref.startsWith("http") ? productHref : `${base}${productHref}`) : `${base}/dp/${asin}`;
        const priceWhole = el.querySelector(".a-price-whole")?.textContent?.trim();
        const priceFrac = el.querySelector(".a-price-fraction")?.textContent?.trim();
        const price = priceWhole ? `$${priceWhole.replace(/\.$/, "")}.${priceFrac ?? "00"}` : el.querySelector(".a-price .a-offscreen")?.textContent?.trim() || null;
        const imageUrl = el.querySelector("img.s-image")?.getAttribute("src") ?? null;
        const rating = el.querySelector(".a-icon-alt")?.textContent?.trim() || null;
        const sponsored = /sponsored/i.test(el.textContent || "");
        const prime = !!el.querySelector(".a-icon-prime, [aria-label*='Prime']");
        out.push({ asin, title: name.slice(0, 200), price, url, image: imageUrl, rating, sponsored, prime });
      }
      return out;
    },
    base,
  );
  const found = results.filter((p) => /\/dp\/|\/gp\/product\//i.test(p.url));
  for (const p of found) s.urls.set(p.asin, p.url);
  return snapshot(s, { results: found.map(({ url, ...rest }) => rest) }, page);
}

async function amazonAdd(s, domain, asin, quantity, page = s.page) {
  if (!/^[A-Z0-9]{10}$/i.test(String(asin))) throw Object.assign(new Error("That isn't an Amazon product ID (ASIN)."), { status: 400 });
  const known = s.urls.get(String(asin).toUpperCase()) || s.urls.get(String(asin));
  const productUrl = known && isProductUrl(known) ? known : `https://www.${domainOf(domain)}/dp/${asin}`;
  try {
    await goto(s, productUrl, page);
  } catch (e) {
    if (e.status) throw e;
    return snapshot(s, { added: false, reason: "The product page didn't load." }, page);
  }
  if (await isCaptcha(page)) return snapshot(s, { added: false, reason: "captcha" }, page);
  const title = await page.$eval("#productTitle, #title", (el) => el.textContent.trim()).catch(() => "");
  // Amazon's delivery estimate for this browser's (guest) location; the real date depends on the address.
  const delivery = await page
    .$eval("#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE, #deliveryBlockMessage, #ddmDeliveryMessage", (el) => el.textContent.replace(/\s+/g, " ").trim().slice(0, 160))
    .catch(() => null);
  const price = await page.$eval("#corePrice_feature_div .a-offscreen, .a-price .a-offscreen", (el) => el.textContent.trim()).catch(() => null);

  const atc = await page
    .waitForSelector(['#add-to-cart-button', '#add-to-cart-button-ubb', 'input[name="submit.add-to-cart"]', 'input[name="submit.addToCart"]', "#submit\\.add-to-cart"].join(", "), { visible: true, timeout: 8000 })
    .catch(() => null);
  if (!atc) return snapshot(s, { added: false, title, price, reason: "No Add to Cart button on this page (likely a buying-options listing, or it needs an option chosen)." }, page);

  const qty = Math.max(1, Math.min(30, Number(quantity) || 1));
  let appliedQty = 1;
  if (qty > 1) {
    try {
      const options = await page
        .$$eval('select[name="quantity"] option', (els) => els.map((o) => Number(o.value)).filter((n) => Number.isFinite(n)))
        .catch(() => []);
      if (options.length > 0) {
        const eligible = options.filter((n) => n <= qty);
        const pick = eligible.length > 0 ? Math.max(...eligible) : Math.min(...options);
        await page.select('select[name="quantity"]', String(pick));
        appliedQty = pick;
        await pause(400);
      }
    } catch {
      /* quantity stays 1; reported below */
    }
  }

  const cartCountBefore = await page.$eval("#nav-cart-count", (el) => el.textContent?.trim() ?? "").catch(() => "");
  try {
    await atc.click({ delay: 30 });
  } catch {
    return snapshot(s, { added: false, title, price, reason: "Couldn't click Add to Cart." }, page);
  }
  const added = await Promise.race([
    page
      .waitForSelector("#attachDisplayAddBaseAlert, #huc-v2-order-row-confirm-text, #sw-atc-details-single-container, #NATC_SMART_WAGON_CONF_MSG_SUCCESS", { timeout: 6000 })
      .then(() => true)
      .catch(() => false),
    (async () => {
      for (let i = 0; i < 12; i++) {
        await pause(500);
        const now = await page.$eval("#nav-cart-count", (el) => el.textContent?.trim() ?? "").catch(() => "");
        if (now && now !== cartCountBefore) return true;
      }
      return false;
    })(),
  ]);
  return snapshot(s, { added, title, price, delivery, quantity: appliedQty, requestedQuantity: qty }, page);
}

// One batch item may take this long; a page that hangs is reported and the batch moves on.
const ITEM_MS = 60_000;

/**
 * Runs a batch one item at a time in the tab the shopper watches (several tabs got stuck and used too much
 * memory). Viewers hear the progress as {t:"tabs", working, done, total}.
 */
async function inTabs(s, items, job) {
  log("session", s.id.slice(0, 6), "batch of", items.length);
  broadcast(s, { t: "tabs", working: 1, done: 0, total: items.length });
  try {
    return await runPool(
      items,
      [s.page],
      (item, page, i) => Promise.race([job(item, page, i), pause(ITEM_MS).then(() => Promise.reject(new Error("The page took too long.")))]),
      (done, total) => {
        s.lastUsed = Date.now();
        broadcast(s, { t: "tabs", working: 1, done, total });
      },
    );
  } finally {
    broadcast(s, { t: "tabs", working: 0, done: items.length, total: items.length });
  }
}

const cleanItems = (items) =>
  (Array.isArray(items) ? items : [])
    .slice(0, BATCH_MAX)
    .map((it) => ({ asin: String(it?.asin ?? "").toUpperCase(), quantity: Math.max(1, Math.min(30, Number(it?.quantity) || 1)) }))
    .filter((it) => /^[A-Z0-9]{10}$/.test(it.asin));

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

/**
 * Sets Amazon's "Deliver to" location to a postal code, so prices, availability and delivery estimates are for
 * where the shopper's order goes (their home, or their hotel). Guest browsers can do this. First Amazon's own
 * location call (what the Deliver to box sends), made from the page so it uses the page's cookies; then, if that
 * didn't take, the Deliver to box itself. Returns what the header shows afterwards.
 */
async function amazonLocation(s, domain, postal) {
  const zip = String(postal ?? "").toUpperCase().replace(/[^A-Z0-9 -]/g, "").replace(/\s+/g, " ").trim().slice(0, 10);
  if (zip.length < 3) throw Object.assign(new Error("Give a postal code."), { status: 400 });
  const base = `https://www.${domainOf(domain)}`;
  if (!s.page.url().startsWith(base)) await goto(s, `${base}/`);
  if (await isCaptcha(s.page)) return snapshot(s, { located: false, deliverTo: "" });
  const compact = zip.replace(/[\s-]/g, "");
  const deliverTo = () => s.page.$eval("#glow-ingress-line2, #nav-global-location-slot", (el) => (el.textContent || "").replace(/\s+/g, " ").trim()).catch(() => "");
  const shows = (t) => t.toUpperCase().replace(/[\s-]/g, "").includes(compact.slice(0, 3));
  const viaApi = await s.page
    .evaluate(async (zipCode) => {
      try {
        const modal = await fetch("/portal-migration/hz/glow/get-rendered-address-selections?deviceType=desktop&pageType=Gateway&storeContext=NoStoreName&actionSource=desktop-modal", { credentials: "include" }).then((r) => r.text());
        const token = (modal.match(/CSRF_TOKEN\s*:\s*"([^"]+)"/) || [])[1];
        if (!token) return false;
        const r = await fetch("/portal-migration/hz/glow/address-change?actionSource=glow", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "anti-csrftoken-a2z": token },
          body: JSON.stringify({ locationType: "LOCATION_INPUT", zipCode, deviceType: "web", storeContext: "generic", pageType: "Gateway", actionSource: "glow" }),
        });
        const j = await r.json().catch(() => null);
        return !!j && (j.isValidAddress === 1 || j.isValidAddress === true || j.successful === 1);
      } catch {
        return false;
      }
    }, zip)
    .catch(() => false);
  await s.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  let shown = await deliverTo();
  if (!shows(shown)) {
    // The Deliver to box: Canada's has two postal-code fields, the US one has one.
    try {
      await s.page.click("#nav-global-location-popover-link, #glow-ingress-block", { delay: 30 });
      await s.page.waitForSelector("#GLUXZipUpdateInput, #GLUXZipUpdateInput_0", { timeout: 6000 });
      if (await s.page.$("#GLUXZipUpdateInput_0")) {
        const [a, b] = [compact.slice(0, 3), compact.slice(3, 6)];
        await s.page.type("#GLUXZipUpdateInput_0", a, { delay: 25 });
        await s.page.type("#GLUXZipUpdateInput_1", b, { delay: 25 });
      } else {
        await s.page.click("#GLUXZipUpdateInput", { clickCount: 3 });
        await s.page.type("#GLUXZipUpdateInput", zip, { delay: 25 });
      }
      await s.page.click("#GLUXZipUpdate input, #GLUXZipUpdate");
      await pause(1500);
      const done = await s.page.$("#GLUXConfirmClose, .a-popover-footer input.a-button-input, button[name='glowDoneButton']");
      if (done) await done.click().catch(() => {});
      await pause(800);
      await s.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      shown = await deliverTo();
    } catch {
      /* the box didn't open: leave Amazon's own location */
    }
  }
  return snapshot(s, { located: viaApi || shows(shown), deliverTo: shown });
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
    await setMode(s, "desktop");
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
    if (url.pathname === "/read" && req.method === "POST") {
      const body = await readJson(req);
      const t0 = Date.now();
      const r = await readPage(body.url);
      log("read", hostOf(r.url), `${r.text.length} chars`, `${r.screenshots.length} shots`, `${Date.now() - t0}ms`);
      return send(res, 200, r);
    }
    const m = url.pathname.match(/^\/sessions(?:\/([a-f0-9]{24}))?(\/.*)?$/);
    if (!m) return send(res, 404, { error: "Not found" });
    const [, id, rest = ""] = m;
    if (!id && req.method === "POST") {
      const s = await createSession();
      return send(res, 200, { id: s.id });
    }
    if (id && !rest && req.method === "DELETE") {
      const s = sessions.get(id);
      if (s) await endSession(s);
      return send(res, 200, { ok: true });
    }
    if (id && rest === "/state" && req.method === "GET") {
      const s = sessions.get(id);
      if (!s) return send(res, 404, { error: "That browser session has closed." });
      s.lastUsed = Date.now();
      return send(res, 200, await snapshot(s));
    }
    if (id && rest === "/release" && req.method === "POST") {
      const s = sessions.get(id);
      if (!s) return send(res, 404, { error: "That browser session has closed." });
      await releaseControl(s, "server");
      return send(res, 200, { ok: true });
    }
    if (id && req.method === "POST") {
      const body = await readJson(req);
      if (rest === "/act") {
        const actions = Array.isArray(body.actions) ? body.actions.slice(0, 12) : [];
        return send(res, 200, await withSession(id, async (s) => {
          // What each smart action did (or why it couldn't), so Neon knows which field to fix by hand.
          const results = [];
          const t0 = Date.now();
          const timing = [];
          for (const a of actions) {
            const t = Date.now();
            const r = await runAction(s, a);
            timing.push(`${a?.type}${a?.field ? `(${String(a.field).slice(0, 24)})` : a?.text ? `(${String(a.text).slice(0, 24)})` : ""} ${Date.now() - t}ms${r && r.ok === false ? " ✗" : ""}`);
            if (SMART.has(a?.type)) results.push({ type: a.type, ...(a.field ? { field: String(a.field).slice(0, 60) } : {}), ...(a.text ? { text: String(a.text).slice(0, 60) } : {}), ...r });
          }
          // Discover Cars: the path too (search and booking steps), for tuning. Amazon stays host-only.
          let where = hostOf(s.page.url());
          if (/discovercars/i.test(where)) {
            try {
              where += new URL(s.page.url()).pathname.slice(0, 80);
            } catch {}
          }
          log("act", s.id.slice(0, 6), where, `${Date.now() - t0}ms:`, timing.join(", "));
          for (const r of results) if (!r.ok && r.fields) log("act", s.id.slice(0, 6), "fields on page:", JSON.stringify(r.fields).slice(0, 900));
          for (const r of results) if (!r.ok && r.calendar) log("act", s.id.slice(0, 6), "calendar:", r.calendar);
          for (const r of results) if (!r.ok && r.widget) log("act", s.id.slice(0, 6), "dropdown:", r.widget);
          return snapshot(s, results.length ? { results } : {}, s.page, body.noShot !== true);
        }));
      }
      if (rest === "/probe") {
        if (!sessions.has(id)) return send(res, 404, { error: "That browser session has closed." });
        const t0 = Date.now();
        const r = await probeUrl(String(body.url ?? ""));
        log("probe", id.slice(0, 6), hostOf(r.url), (() => { try { return new URL(r.url).pathname.slice(0, 60); } catch { return ""; } })(), r.kind, `${Date.now() - t0}ms`);
        return send(res, 200, r);
      }
      if (rest === "/browser-tool") {
        // Claude's browser use toolset: member calls in order, stopping at the first failure (browser-tool.mjs).
        const calls = (Array.isArray(body.calls) ? body.calls : []).slice(0, 12);
        return send(res, 200, await withSession(id, async (s) => {
          const vp = s.mode === "phone" ? PHONE_VIEW : VIEW;
          const shot = async () => Buffer.from(await s.page.screenshot({ type: "jpeg", quality: 60, captureBeyondViewport: false, clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale: 1 } })).toString("base64");
          const results = [];
          const timing = [];
          const t0 = Date.now();
          let failed = false;
          for (const c of calls) {
            if (failed) {
              results.push({ content: [{ type: "text", text: "Not executed: an earlier browser action in this turn failed." }], isError: true });
              continue;
            }
            const t = Date.now();
            const r = await runBrowserTool(s.page, String(c?.name ?? ""), c?.input ?? {}, { goto: (u) => goto(s, u), shot });
            timing.push(`${c?.name} ${Date.now() - t}ms${r.isError ? " ✗" : ""}`);
            results.push(r);
            if (r.isError) failed = true;
          }
          let where = hostOf(s.page.url());
          if (/discovercars/i.test(where)) try { where += new URL(s.page.url()).pathname.slice(0, 80); } catch {}
          log("tool", s.id.slice(0, 6), where, `${Date.now() - t0}ms:`, timing.join(", "));
          const needs = await needsShopper(s.page);
          return { results, url: s.page.url(), title: await s.page.title().catch(() => ""), needsShopper: needs };
        }));
      }
      if (rest === "/amazon/search") return send(res, 200, await withSession(id, (s) => amazonSearch(s, body.domain, body.query ?? "")));
      if (rest === "/amazon/add") return send(res, 200, await withSession(id, (s) => amazonAdd(s, body.domain, body.asin, body.quantity)));
      if (rest === "/amazon/cart") return send(res, 200, await withSession(id, (s) => amazonCart(s, body.domain)));
      if (rest === "/amazon/location") return send(res, 200, await withSession(id, (s) => amazonLocation(s, body.domain, body.postal)));
      if (rest === "/amazon/search-many") {
        const queries = (Array.isArray(body.queries) ? body.queries : []).map((q) => String(q ?? "").trim().slice(0, 200)).filter(Boolean).slice(0, 8);
        if (!queries.length) return send(res, 400, { error: "No searches given." });
        return send(res, 200, await withSession(id, async (s) => {
          const results = await inTabs(s, queries, async (query, page) => {
            const r = await amazonSearch(s, body.domain, query, page);
            return { query, results: r.results ?? [], captcha: r.captcha, signIn: r.signIn, needsShopper: r.needsShopper };
          });
          return snapshot(s, { searches: results });
        }));
      }
      if (rest === "/amazon/add-many") {
        const items = cleanItems(body.items);
        if (!items.length) return send(res, 400, { error: "No valid items (ASIN and quantity) given." });
        return send(res, 200, await withSession(id, async (s) => {
          const results = await inTabs(s, items, async (it, page) => {
            const r = await amazonAdd(s, body.domain, it.asin, it.quantity, page);
            return { asin: it.asin, added: !!r.added, title: r.title, price: r.price ?? null, delivery: r.delivery ?? null, quantity: r.quantity, requestedQuantity: it.quantity, reason: r.reason, captcha: r.captcha, signIn: r.signIn };
          });
          return snapshot(s, { items: results });
        }));
      }
    }
    send(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "The browser hit a problem." });
    // Never log page contents or what the shopper typed: just the kind of failure.
    if (!e.status) console.error("[browser]", e?.name || "Error", String(e?.message || "").replace(/https?:\/\/\S+/g, "<url>").slice(0, 200));
  }
});

// ---------- Live view: shopper control and input ----------

/** The shopper's full-screen browser area in CSS px, from a control or viewport message, or null. */
function screenOf(m) {
  const w = m?.w, h = m?.h;
  if (typeof w !== "number" || typeof h !== "number" || !Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 200 || w > 3000 || h > 3000) return null;
  return { w, h };
}

/** Validates one input message from the live view. Returns the step to run, or an error code. */
function parseInput(m) {
  switch (m?.t) {
    case "tap": {
      const { x, y } = m;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
      return { t: "tap", x, y };
    }
    case "scroll": {
      const dy = m.dy;
      if (typeof dy !== "number" || !Number.isFinite(dy)) return null;
      return { t: "scroll", dy: Math.max(-4000, Math.min(4000, Math.round(dy))) };
    }
    case "type":
      if (typeof m.text !== "string" || !m.text || m.text.length > 2000) return null;
      return { t: "type", text: m.text };
    case "key": {
      if (!KEYS.includes(m.key)) return null;
      const count = m.count === undefined ? 1 : m.count;
      if (!Number.isInteger(count) || count < 1 || count > 200) return null;
      return { t: "key", key: m.key, count };
    }
    case "back":
      return { t: "back" };
    default:
      return null;
  }
}

/** Queues shopper input: run one at a time in arrival order; consecutive scrolls not yet started are merged. */
function enqueue(s, ws, item, n) {
  const last = s.queue[s.queue.length - 1];
  if (item.t === "scroll" && last?.t === "scroll" && last.ws === ws && !last.started) {
    last.dy = Math.max(-4000, Math.min(4000, last.dy + item.dy));
    last.ns.push(n);
    return;
  }
  if (s.queue.length >= INPUT_QUEUE && item.t !== "mode") return reply(ws, { t: "error", n, code: "busy", message: "Slow down a little: the page is catching up." });
  s.queue.push({ ...item, ws, ns: [n] });
  drain(s);
}

/** Runs queued steps in order. A step that fails is reported, never retried (taps and typing aren't safe to repeat). */
async function drain(s) {
  if (s.draining) return;
  s.draining = true;
  try {
    while (s.queue.length && sessions.has(s.id)) {
      const it = s.queue[0];
      it.started = true;
      try {
        // Switching to the phone site waits for a step Neon is in the middle of (it would change the page under it).
        if (it.t === "mode") for (let i = 0; i < 600 && s.busy && sessions.has(s.id); i++) await pause(100);
        await Promise.race([runInput(s, it), pause(STEP_MS).then(() => Promise.reject(new Error("step timed out")))]);
        for (const n of it.ns) if (it.ws && n !== undefined) reply(it.ws, { t: "ack", n });
      } catch {
        for (const n of it.ns) if (it.ws) reply(it.ws, { t: "error", n, code: "failed", message: "That didn't work on the page. Try again." });
      } finally {
        s.queue.shift();
        it.resolve?.();
      }
    }
  } finally {
    s.draining = false;
  }
}

async function runInput(s, it) {
  const page = s.page;
  s.lastUsed = Date.now();
  if (it.t === "mode") return setMode(s, it.mode);
  if (it.t === "resize") return resizePhone(s);
  if (it.t === "tap") {
    const f = s.frame || (s.mode === "phone" ? { w: PHONE_VIEW.width, h: PHONE_VIEW.height } : { w: VIEW.width, h: VIEW.height });
    const x = it.x * f.w, y = it.y * f.h;
    if (s.mode === "phone") await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y, { delay: 30 });
    // Tell the phone whether a text field now has focus, so it can offer the keyboard.
    await pause(250);
    const editing = await page
      .evaluate(() => {
        const el = document.activeElement;
        return !!el && (el.isContentEditable || (el.tagName === "INPUT" && !["button", "submit", "checkbox", "radio", "image", "range", "color", "file", "reset", "hidden"].includes(el.type)) || el.tagName === "TEXTAREA");
      })
      .catch(() => false);
    if (it.ws) reply(it.ws, { t: "focus", editing });
    return;
  }
  if (it.t === "type") return page.keyboard.type(it.text);
  if (it.t === "key") {
    for (let i = 0; i < (it.count || 1); i++) await page.keyboard.press(it.key);
    return pause(120);
  }
  if (it.t === "scroll") {
    if (it.dy) await page.evaluate((d) => window.scrollBy({ top: d, behavior: "instant" }), it.dy);
    return pause(60);
  }
  if (it.t === "back") {
    // Waits for the page to load inside this step, so the next tap lands on the new page.
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 });
    return pause(200);
  }
}

/** The shopper takes control from this socket: their phone gets Amazon's phone site. */
function takeControl(s, ws, screen) {
  if (screen) s.screen = screen;
  if (s.controller && s.controller !== ws) reply(s.controller, { t: "control", on: false, by: "shopper" });
  s.userControl = true;
  s.controller = ws;
  broadcast(s, { t: "control", on: true, by: "shopper" });
  enqueue(s, null, { t: "mode", mode: "phone" }, undefined);
  status(s).catch(() => {});
}

/** Control goes back to Neon (hand back, the socket closed, or the run resumed): drop pending input, desktop again. */
async function releaseControl(s, by) {
  const had = s.userControl;
  s.userControl = false;
  s.controller = null;
  // Everyone hears that control ended before any dropped input is answered, so no screen takes it back.
  if (had || s.mode !== "desktop") broadcast(s, { t: "control", on: false, by });
  // Input still waiting is dropped (it was meant for the shopper's turn); the step running now finishes.
  for (const it of s.queue.splice(s.queue[0]?.started ? 1 : 0)) {
    for (const n of it.ns ?? []) if (it.ws && n !== undefined) reply(it.ws, { t: "error", n, code: "dropped", message: "Neon has the browser now." });
    it.resolve?.();
  }
  if (had || s.mode !== "desktop") {
    await new Promise((resolve) => {
      s.queue.push({ t: "mode", mode: "desktop", ws: null, ns: [], resolve });
      drain(s);
    });
  }
  status(s).catch(() => {});
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  const id = url.searchParams.get("id") || "";
  const s = url.pathname === "/live" ? sessions.get(id) : null;
  const deny = (code, text) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  if (!liveTokenOk(id, url.searchParams.get("exp") || "", url.searchParams.get("token") || "")) return deny(401, "Unauthorized");
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(String(req.headers.origin || ""))) return deny(403, "Forbidden");
  if (!s) return deny(404, "Not Found");
  wss.handleUpgrade(req, socket, head, (ws) => {
    s.clients.add(ws);
    s.lastUsed = Date.now();
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    if (s.frame) reply(ws, { t: "frame-meta", w: s.frame.w, h: s.frame.h });
    if (s.lastFrame) deliverFrame(ws, s.lastFrame, FRAME_QUEUE_BYTES);
    status(s).catch(() => {});
    ws.on("close", () => {
      s.clients.delete(ws);
      stopDelivery(ws);
      // The shopper's phone went away: give control back so the session isn't stuck in their hands.
      if (s.controller === ws && sessions.has(s.id)) releaseControl(s, "shopper").catch(() => {});
    });
    ws.on("message", (raw, isBinary) => {
      if (isBinary || !sessions.has(s.id)) return;
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return reply(ws, { t: "error", code: "invalid", message: "Couldn't read that." });
      }
      s.lastUsed = Date.now();
      const n = Number.isInteger(m?.n) ? m.n : undefined;
      if (m?.t === "control") {
        if (m.on) takeControl(s, ws, screenOf(m));
        else if (s.controller === ws) releaseControl(s, "shopper").catch(() => {});
        return n !== undefined ? reply(ws, { t: "ack", n }) : undefined;
      }
      if (!s.userControl || s.controller !== ws) return reply(ws, { t: "error", n, code: "not_in_control", message: "Tap Take over first." });
      if (m?.t === "viewport") {
        const sc = screenOf(m);
        if (!sc) return reply(ws, { t: "error", n, code: "invalid", message: "That input wasn't valid." });
        s.screen = sc;
        return enqueue(s, ws, { t: "resize" }, n);
      }
      const item = parseInput(m);
      if (!item) return reply(ws, { t: "error", n, code: "invalid", message: "That input wasn't valid." });
      enqueue(s, ws, item, n);
    });
  });
});

// Drop live-view sockets that stopped answering (a phone that went to sleep mid-connection).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30_000).unref();

setInterval(async () => {
  for (const s of [...sessions.values()]) {
    if (s.busy || s.userControl) continue;
    const idle = Date.now() - s.lastUsed;
    if (idle > IDLE_MS) endSession(s, "Closed after being idle.");
    // Unwatched: close early, unless the page is waiting on the shopper (a robot check they'll come back to).
    else if (!s.clients.size && idle > UNWATCHED_MS && !(await needsShopper(s.page).catch(() => null)))
      endSession(s, "Closed while nobody was watching (Neon reopens it when needed).");
  }
}, 30_000).unref();

server.listen(PORT, () => console.log(`[browser] listening on ${PORT}, up to ${MAX_SESSIONS} sessions`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => {
  for (const s of sessions.values()) await endSession(s, "The browser service is restarting.");
  await browser?.close().catch(() => {});
  process.exit(0);
});
