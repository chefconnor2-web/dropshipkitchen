// The shopper's own Gmail, connected so Neon can send email from their address (for example to a hotel's front
// desk). Google sign-in with the gmail.send scope only: Neon can send, never read. The refresh token is stored
// encrypted; every message is sent only after the shopper approves the exact draft in the chat.
//
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  an OAuth client (type "Web application") in Google Cloud, with the
//   Gmail API enabled and the redirect URI  <SITE_URL>/api/google/callback
// GMAIL_TOKEN_KEY                          optional: the key tokens are encrypted with (default: a random key
//   kept in the database)
// GOOGLE_OAUTH_URL / GOOGLE_TOKEN_URL / GMAIL_API_URL  tests only

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send"];
const oauthUrl = () => process.env.GOOGLE_OAUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const tokenUrl = () => process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const gmailUrl = () => (process.env.GMAIL_API_URL || "https://gmail.googleapis.com").replace(/\/+$/, "");

export function gmailConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

export const redirectUri = () => `${config.siteUrl}/api/google/callback`;

/** Who owns a connection: the signed-in customer, else this browser (like chats). */
export interface GmailOwner {
  customerId: string | null;
  visitorId: string | null;
}
const ownerWhere = (o: GmailOwner) => (o.customerId ? { customerId: o.customerId } : o.visitorId ? { visitorId: o.visitorId } : null);

/* ---------- Encryption of the refresh token ---------- */

const KEY_SETTING = "gmail.token-key";

/** The encryption key: GMAIL_TOKEN_KEY, else a random one made once and kept in the database. */
async function key(): Promise<Buffer> {
  let base = process.env.GMAIL_TOKEN_KEY?.trim();
  if (!base) {
    const row = await prisma.setting.findUnique({ where: { key: KEY_SETTING } });
    if (row) base = row.value;
    else {
      // Two first connections at once: keep whichever was stored first.
      await prisma.setting.upsert({ where: { key: KEY_SETTING }, create: { key: KEY_SETTING, value: randomBytes(32).toString("base64url") }, update: {} });
      base = (await prisma.setting.findUniqueOrThrow({ where: { key: KEY_SETTING } })).value;
    }
  }
  return createHash("sha256").update(`gmail-token:${base}`).digest();
}

export async function sealToken(token: string): Promise<string> {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", await key(), iv);
  const enc = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export async function openToken(sealed: string): Promise<string> {
  const [iv, tag, enc] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", await key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

/* ---------- Sign-in ---------- */

export function authUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    // Always ask, so Google returns a refresh token even if the shopper connected before.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${oauthUrl()}?${q}`;
}

/** The address inside a Google id token (we just got it from Google over TLS, so its payload is trusted). */
export function emailFromIdToken(idToken: string | undefined): string | null {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string; email_verified?: boolean };
    return payload.email && payload.email_verified !== false ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function tokenCall(params: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; id_token?: string; scope?: string; error?: string; error_description?: string }> {
  const r = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID?.trim() ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "", ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  return (await r.json().catch(() => ({}))) as Awaited<ReturnType<typeof tokenCall>>;
}

/** Finishes sign-in: trades the code for tokens and stores the (encrypted) refresh token for this owner. */
export async function connectGmail(code: string, owner: GmailOwner): Promise<{ email: string } | { error: string }> {
  const where = ownerWhere(owner);
  if (!where) return { error: "Open the chat first, then connect Gmail." };
  const t = await tokenCall({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!t.refresh_token) return { error: t.error_description || "Google didn't grant access. Try again." };
  if (t.scope && !t.scope.includes("gmail.send")) return { error: "Allow Chit to send email for you, then try again." };
  const email = emailFromIdToken(t.id_token);
  if (!email) return { error: "Google didn't share your address. Try again." };
  const refreshTokenEnc = await sealToken(t.refresh_token);
  const existing = await prisma.gmailConnection.findFirst({ where });
  if (existing) await prisma.gmailConnection.update({ where: { id: existing.id }, data: { email, refreshTokenEnc } });
  else await prisma.gmailConnection.create({ data: { ...where, email, refreshTokenEnc } });
  return { email };
}

export async function gmailFor(owner: GmailOwner): Promise<{ email: string } | null> {
  const where = ownerWhere(owner);
  if (!where) return null;
  const c = await prisma.gmailConnection.findFirst({ where, select: { email: true } });
  return c ? { email: c.email } : null;
}

export async function disconnectGmail(owner: GmailOwner): Promise<void> {
  const where = ownerWhere(owner);
  if (where) await prisma.gmailConnection.deleteMany({ where });
}

/* ---------- Sending ---------- */

const header = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
/** RFC 2047 for a subject that isn't plain ASCII. */
const encodeSubject = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** The raw message Gmail sends (plain text, UTF-8). */
export function buildMessage(m: { from: string; to: string[]; cc?: string[]; subject: string; text: string }): string {
  const lines = [
    `From: ${header(m.from)}`,
    `To: ${m.to.map(header).join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(header).join(", ")}`] : []),
    `Subject: ${encodeSubject(header(m.subject))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return lines.join("\r\n");
}

/** Sends from the owner's Gmail. Throws with a shopper-facing message when it can't. */
export async function sendFromGmail(owner: GmailOwner, m: { to: string[]; cc?: string[]; subject: string; text: string }): Promise<{ id: string; from: string }> {
  const where = ownerWhere(owner);
  const c = where ? await prisma.gmailConnection.findFirst({ where }) : null;
  if (!c) throw new Error("Gmail isn't connected.");
  const t = await tokenCall({ refresh_token: await openToken(c.refreshTokenEnc), grant_type: "refresh_token" });
  if (!t.access_token) {
    if (t.error === "invalid_grant") await prisma.gmailConnection.delete({ where: { id: c.id } }).catch(() => {});
    throw new Error("Gmail access has expired. Connect Gmail again.");
  }
  const raw = Buffer.from(buildMessage({ from: c.email, ...m }), "utf8").toString("base64url");
  const r = await fetch(`${gmailUrl()}/gmail/v1/users/me/messages/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await r.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!r.ok || !body.id) throw new Error(`Gmail didn't send it (${body.error?.message ?? r.status}).`);
  return { id: body.id, from: c.email };
}
