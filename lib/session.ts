// Shopper accounts: a signed cookie holding the customer id. Shoppers sign in with a one-tap email link
// (or by subscribing). The signing key is generated once and kept in the database, so no setup is needed.
import { cookies } from "next/headers";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";

const COOKIE = "cs_member";
const SECRET_KEY = "session.secret";
const MAX_AGE = 60 * 60 * 24 * 180;
const LINK_TTL_MS = 30 * 60_000;

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

/** The signed-in customer's id, or null (safe in server components). */
export async function getMemberId(): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  return verifyValue(raw, await signingKey());
}

export async function getMember() {
  const id = await getMemberId();
  return id ? prisma.customer.findUnique({ where: { id } }) : null;
}

/** Only callable from server actions / route handlers (sets a cookie). */
export async function signIn(customerId: string) {
  (await cookies()).set(COOKIE, signValue(customerId, await signingKey()), { httpOnly: true, sameSite: "lax", path: "/", maxAge: MAX_AGE, secure: process.env.NODE_ENV === "production" });
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** A one-time sign-in token for this email (valid 30 minutes). */
export async function createLoginToken(email: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await prisma.loginToken.create({ data: { tokenHash: hash(token), email: email.trim().toLowerCase(), expiresAt: new Date(Date.now() + LINK_TTL_MS) } });
  return token;
}

/** Uses a sign-in token: returns the customer (created if new), or null when it's invalid, used or expired. */
export async function redeemLoginToken(token: string) {
  const row = await prisma.loginToken.findUnique({ where: { tokenHash: hash(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) return null;
  const claimed = await prisma.loginToken.updateMany({ where: { tokenHash: row.tokenHash, usedAt: null }, data: { usedAt: new Date() } });
  if (!claimed.count) return null;
  return prisma.customer.upsert({ where: { email: row.email }, create: { email: row.email }, update: {} });
}
