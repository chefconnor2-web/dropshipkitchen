// Shopper accounts. A shopper signs in by email: we send a 6-digit code, they type it in, and their browser
// gets a session. Sessions live in the database (the cookie is a random token; only its hash is stored), so
// signing out really ends them, and "sign out everywhere" ends them all.
//
// Tenancy: everything a shopper owns (chats, chat photos, cart, orders, subscriptions) is reachable only
// through getMemberId() or, for anonymous browsers, the cs_vid / cs_cart cookies; see lib/chat-session.ts and
// lib/cart.ts. Signing in moves the browser's anonymous chats and cart into the account; signing out gives
// the browser a fresh anonymous identity, so the next person on a shared computer sees none of it.
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { sendEmail } from "@/lib/email";

const COOKIE = "cs_session";
const LEGACY_COOKIE = "cs_member";
const SECRET_KEY = "session.secret";
const SESSION_DAYS = 90;
/** lastSeenAt (and the sliding expiry) is refreshed at most this often, so reads stay cheap. */
const TOUCH_MS = 24 * 3600_000;

export const CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses allowed per code. */
export const CODE_MAX_ATTEMPTS = 5;
/** Codes per email per hour, and the gap between two codes to one email. */
const CODES_PER_EMAIL_HOUR = 5;
const CODE_GAP_MS = 60_000;
/** Codes one network address may request per hour (across emails). */
const CODES_PER_IP_HOUR = 20;
/** Wrong guesses per email per hour (across codes) before sign-in pauses for that email. */
const FAILS_PER_EMAIL_HOUR = 10;

let secret: string | null = null;
async function signingKey(): Promise<string> {
  if (secret) return secret;
  const row = await prisma.setting.findUnique({ where: { key: SECRET_KEY } });
  if (row) return (secret = row.value);
  const fresh = randomBytes(32).toString("base64url");
  // Two first requests at once: keep whichever was stored first.
  await prisma.setting.upsert({ where: { key: SECRET_KEY }, create: { key: SECRET_KEY, value: fresh }, update: {} });
  return (secret = (await prisma.setting.findUniqueOrThrow({ where: { key: SECRET_KEY } })).value);
}

export function signValue(value: string, key: string): string {
  return `${value}.${createHmac("sha256", key).update(value).digest("base64url")}`;
}

export function verifyValue(signed: string, key: string): string | null {
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const want = Buffer.from(signValue(value, key));
  const got = Buffer.from(signed);
  return want.length === got.length && timingSafeEqual(want, got) ? value : null;
}

/**
 * A link token that opens one order's page without signing in (it goes in the order emails and the /track
 * lookup). It is an HMAC of the order id with the server secret, so it can't be guessed or moved to another order.
 */
export async function orderViewToken(orderId: string): Promise<string> {
  return createHmac("sha256", await signingKey()).update(`order-view\n${orderId}`).digest("base64url").slice(0, 32);
}

export async function checkOrderViewToken(orderId: string, token: string | undefined | null): Promise<boolean> {
  if (!token || token.length !== 32) return false;
  const want = Buffer.from(await orderViewToken(orderId));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

export function normalizeEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(email) ? email : null;
}

/** A same-site path to return to after signing in, or the account page (never another site). */
export function safeNext(raw: unknown): string {
  const n = String(raw ?? "");
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") && n.length < 300 ? n : "/account";
}

// ---------- sessions ----------

/** This request's session (looked up once per request), or null. */
const currentSession = cache(async (): Promise<{ id: string; customerId: string } | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await prisma.customerSession.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_MS)
    await prisma.customerSession
      .update({ where: { id: row.id }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) } })
      .catch(() => null);
  return { id: row.id, customerId: row.customerId };
});

/** The signed-in customer's id, or null (safe in server components). */
export async function getMemberId(): Promise<string | null> {
  return (await currentSession())?.customerId ?? null;
}

export async function getMember() {
  const id = await getMemberId();
  return id ? prisma.customer.findUnique({ where: { id } }) : null;
}

/**
 * Signs this browser in as the customer and moves its anonymous chats and cart into the account.
 * Only callable from server actions / route handlers (sets cookies).
 */
export async function startSession(customerId: string) {
  const jar = await cookies();
  const token = randomBytes(32).toString("base64url");
  const ua = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
  await prisma.customerSession.create({ data: { tokenHash: sha256(token), customerId, userAgent: ua, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) } });
  jar.set(COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 86_400, secure: process.env.NODE_ENV === "production" });
  jar.delete(LEGACY_COOKIE);
  await claimBrowserData(customerId);
}

/** Moves what this browser made while signed out (chats, photos, cart) into the customer's account. */
async function claimBrowserData(customerId: string) {
  const jar = await cookies();
  const visitorId = jar.get("cs_vid")?.value;
  if (visitorId) {
    await prisma.assistantChat.updateMany({ where: { visitorId, customerId: null }, data: { customerId } });
    await prisma.assistantImage.updateMany({ where: { visitorId, customerId: null }, data: { customerId } });
  }
  const cartId = jar.get("cs_cart")?.value;
  const browserCart = cartId ? await prisma.cart.findUnique({ where: { id: cartId }, include: { _count: { select: { items: true, boxes: true } } } }) : null;
  const browserHasItems = !!browserCart && browserCart.customerId === null && browserCart._count.items + browserCart._count.boxes > 0;
  if (browserHasItems) {
    // What they just put in the cart wins; it becomes their account's cart.
    await prisma.cart.update({ where: { id: browserCart.id }, data: { customerId } });
    return;
  }
  // Otherwise pick up the cart they left in the account on another device.
  const saved = await prisma.cart.findFirst({ where: { customerId, OR: [{ items: { some: {} } }, { boxes: { some: {} } }] }, orderBy: { updatedAt: "desc" } });
  if (saved) jar.set("cs_cart", saved.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  else if (browserCart && browserCart.customerId && browserCart.customerId !== customerId) jar.delete("cs_cart");
}

/** Ends this browser's session and gives it a fresh anonymous identity (new chat history, empty cart). */
export async function endSession() {
  const jar = await cookies();
  const s = await currentSession();
  if (s) await prisma.customerSession.update({ where: { id: s.id }, data: { revokedAt: new Date() } }).catch(() => null);
  for (const name of [COOKIE, LEGACY_COOKIE, "cs_vid", "cs_cart", "cs_chat"]) jar.delete(name);
}

/** Ends every session of the signed-in customer (all devices), including this one. */
export async function endAllSessions() {
  const s = await currentSession();
  if (s) await prisma.customerSession.updateMany({ where: { customerId: s.customerId, revokedAt: null }, data: { revokedAt: new Date() } });
  await endSession();
}

export async function activeSessionCount(customerId: string): Promise<number> {
  return prisma.customerSession.count({ where: { customerId, revokedAt: null, expiresAt: { gt: new Date() } } });
}

// ---------- sign-in codes ----------

/** HMAC of email + code with the server's secret: a leaked table can't be brute-forced offline. */
async function codeHash(email: string, code: string) {
  return createHmac("sha256", await signingKey()).update(`${email}\n${code}`).digest("hex");
}

export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim().slice(0, 64) || null;
}

export type CodeRequest = { ok: true } | { ok: false; message: string };

/**
 * Emails a sign-in code. The answer never says whether an account exists. Rate-limited per email and per
 * network address so the form can't flood an inbox or be used to guess codes.
 */
export async function requestLoginCode(email: string): Promise<CodeRequest> {
  const ip = await clientIp();
  const hourAgo = new Date(Date.now() - 3600_000);
  const [last, perEmail, perIp] = await Promise.all([
    prisma.loginCode.findFirst({ where: { email, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.loginCode.count({ where: { email, createdAt: { gte: hourAgo } } }),
    ip ? prisma.loginCode.count({ where: { ip, createdAt: { gte: hourAgo } } }) : Promise.resolve(0),
  ]);
  // An unused code sent in the last minute is still on its way: the shopper can use that one.
  if (last && Date.now() - last.createdAt.getTime() < CODE_GAP_MS) return { ok: true };
  if (perEmail >= CODES_PER_EMAIL_HOUR || perIp >= CODES_PER_IP_HOUR) return { ok: false, message: "Too many codes requested. Please wait a while and try again." };

  const code = newCode();
  // A new code replaces any earlier one for this email.
  await prisma.loginCode.updateMany({ where: { email, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.loginCode.create({ data: { email, codeHash: await codeHash(email, code), ip, expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
  const log = await sendEmail({
    to: email,
    kind: "sign_in",
    subject: `${code} is your ${config.storeName} sign-in code`,
    text: `Your ${config.storeName} sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email; nobody can sign in without the code.`,
    html: `<p style="font-size:15px">Your ${escapeHtml(config.storeName)} sign-in code:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;font-family:monospace;margin:12px 0">${code}</p><p style="font-size:13px;color:#666">It expires in 10 minutes. If you didn't ask for it, you can ignore this email; nobody can sign in without the code.</p>`,
  });
  // The email log keeps the message for the admin; blank the code out of it once sent.
  await prisma.emailLog.update({ where: { id: log.id }, data: { subject: `Sign-in code for ${config.storeName}`, text: "(sign-in code hidden)", html: "<p>(sign-in code hidden)</p>" } }).catch(() => null);
  if (log.status !== "sent") return { ok: false, message: "We couldn’t send the email right now. Please try again later." };
  return { ok: true };
}

export type CodeCheck = { ok: true; customerId: string } | { ok: false; message: string };

/** Checks a code; on success returns the customer (created on first sign-in). */
export async function verifyLoginCode(email: string, rawCode: string): Promise<CodeCheck> {
  const code = rawCode.replace(/\D/g, "");
  const wrong = { ok: false as const, message: "That code isn’t right, or it has expired. Check the latest email or send a new code." };
  if (code.length !== 6) return wrong;
  const hourAgo = new Date(Date.now() - 3600_000);
  const fails = await prisma.loginCode.aggregate({ where: { email, createdAt: { gte: hourAgo } }, _sum: { attempts: true } });
  if ((fails._sum.attempts ?? 0) >= FAILS_PER_EMAIL_HOUR) return { ok: false, message: "Too many wrong codes. Please wait an hour and try again." };

  const row = await prisma.loginCode.findFirst({ where: { email, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
  if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return wrong;
  const want = Buffer.from(row.codeHash, "hex");
  const got = Buffer.from(await codeHash(email, code), "hex");
  if (!(want.length === got.length && timingSafeEqual(want, got))) {
    await prisma.loginCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    return wrong;
  }
  // Single use: only one request can claim it, even if two arrive at once.
  const claimed = await prisma.loginCode.updateMany({ where: { id: row.id, usedAt: null, attempts: { lt: CODE_MAX_ATTEMPTS } }, data: { usedAt: new Date() } });
  if (!claimed.count) return wrong;
  const customer = await prisma.customer.upsert({ where: { email }, create: { email }, update: {} });
  return { ok: true, customerId: customer.id };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------- testers ----------
// A browser the owner turned on at /admin/instacart (behind the admin login) gets features still in testing,
// like the Instacart connector before it launches. The cookie is signed, so it can't be made up.
export const TESTER_COOKIE = "cs_tester";

export async function testerCookieValue(): Promise<string> {
  return signValue("tester", await signingKey());
}

export async function isTester(): Promise<boolean> {
  const raw = (await cookies()).get(TESTER_COOKIE)?.value;
  return !!raw && verifyValue(raw, await signingKey()) === "tester";
}
