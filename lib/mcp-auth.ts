// OAuth 2.1 for the Chit MCP, so Claude's custom connectors and ChatGPT apps can act for one signed-in Chit
// customer. Apps register themselves (dynamic client registration), send the customer to /oauth/authorize,
// the customer signs in with their email code and approves, and the app swaps the one-time code (with PKCE)
// for an access token (1 hour) and a refresh token (60 days, replaced on every use). Only hashes are stored.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

export const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 60 * 86_400_000;
const REQUEST_TTL_MS = 15 * 60_000;
export const SCOPE = "chit";

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const token = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const mcpUrl = () => `${config.siteUrl}/mcp`;
export const resourceMetadataUrl = () => `${config.siteUrl}/.well-known/oauth-protected-resource/mcp`;

export function authServerMetadata() {
  const s = config.siteUrl;
  return {
    issuer: s,
    authorization_endpoint: `${s}/oauth/authorize`,
    token_endpoint: `${s}/oauth/token`,
    registration_endpoint: `${s}/oauth/register`,
    revocation_endpoint: `${s}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    service_documentation: `${s}/connect`,
  };
}

export function resourceMetadata() {
  return {
    resource: mcpUrl(),
    authorization_servers: [config.siteUrl],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: `${config.storeName} travel`,
    resource_documentation: `${config.siteUrl}/connect`,
  };
}

/** https anywhere, or http only on this machine (MCP Inspector and local testing). No fragments. */
export function okRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 500) return false;
  try {
    const u = new URL(raw);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export async function registerClient(body: Record<string, unknown>): Promise<{ error: string } | Record<string, unknown>> {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || uris.length > 5 || !uris.every(okRedirectUri)) return { error: "redirect_uris must be 1 to 5 https URLs (or http://localhost)." };
  const name = String(body.client_name ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || new URL(uris[0] as string).hostname;
  const id = `mcp_${token(18)}`;
  await prisma.mcpClient.create({ data: { id, name, redirectUris: JSON.stringify(uris) } });
  return {
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export async function getClient(id: string) {
  if (!/^mcp_[A-Za-z0-9_-]{10,40}$/.test(id)) return null;
  const c = await prisma.mcpClient.findUnique({ where: { id } });
  return c ? { ...c, uris: JSON.parse(c.redirectUris) as string[] } : null;
}

/**
 * Checks an authorize request. Errors the app can be told about go back to its redirect URI; a bad client or
 * redirect URI is shown on our page instead (never redirect to an unregistered address).
 */
export async function startAuthorize(q: URLSearchParams): Promise<{ page: string } | { redirect: string } | { requestId: string }> {
  const client = await getClient(q.get("client_id") ?? "");
  if (!client) return { page: "This app isn't registered with Chit. Remove the connector and add it again." };
  const redirectUri = q.get("redirect_uri") ?? (client.uris.length === 1 ? client.uris[0] : "");
  if (!client.uris.includes(redirectUri)) return { page: "This app asked to send you to an address it didn't register." };
  const state = (q.get("state") ?? "").slice(0, 500);
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    return { redirect: u.toString() };
  };
  if (q.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back("invalid_request", "PKCE with S256 is required.");
  const resource = (q.get("resource") ?? "").slice(0, 300);
  if (resource && resource.replace(/\/+$/, "") !== mcpUrl()) return back("invalid_target", `The resource must be ${mcpUrl()}.`);
  const row = await prisma.mcpAuthRequest.create({
    data: { clientId: client.id, redirectUri, state, codeChallenge: challenge, scope: SCOPE, resource, expiresAt: new Date(Date.now() + REQUEST_TTL_MS) },
  });
  return { requestId: row.id };
}

export async function pendingRequest(id: string) {
  const r = await prisma.mcpAuthRequest.findUnique({ where: { id } });
  if (!r || r.usedAt || r.codeHash || r.expiresAt <= new Date()) return null;
  const client = await getClient(r.clientId);
  return client ? { ...r, client } : null;
}

/** The customer approved (or declined): where to send their browser next. */
export async function decide(id: string, customerId: string, allow: boolean): Promise<string | null> {
  const r = await pendingRequest(id);
  if (!r) return null;
  const u = new URL(r.redirectUri);
  if (r.state) u.searchParams.set("state", r.state);
  if (!allow) {
    await prisma.mcpAuthRequest.update({ where: { id }, data: { usedAt: new Date() } });
    u.searchParams.set("error", "access_denied");
    return u.toString();
  }
  const code = token();
  // A short window to swap the code for tokens.
  await prisma.mcpAuthRequest.update({ where: { id }, data: { customerId, codeHash: sha256(code), expiresAt: new Date(Date.now() + 10 * 60_000) } });
  u.searchParams.set("code", code);
  u.searchParams.set("iss", config.siteUrl);
  return u.toString();
}

export interface TokenError {
  error: string;
  error_description: string;
}

async function issue(clientId: string, customerId: string, grantId: string) {
  const access = token();
  const refresh = token();
  const now = Date.now();
  await prisma.mcpToken.createMany({
    data: [
      { tokenHash: sha256(access), kind: "access", grantId, clientId, customerId, expiresAt: new Date(now + ACCESS_TTL_S * 1000) },
      { tokenHash: sha256(refresh), kind: "refresh", grantId, clientId, customerId, expiresAt: new Date(now + REFRESH_TTL_MS) },
    ],
  });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

const pkceOk = (verifier: string, challenge: string) => {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const want = Buffer.from(challenge);
  const got = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  return want.length === got.length && timingSafeEqual(want, got);
};

/** The token endpoint (form fields). */
export async function exchange(f: URLSearchParams): Promise<TokenError | Awaited<ReturnType<typeof issue>>> {
  const bad = (error: string, error_description: string): TokenError => ({ error, error_description });
  const clientId = f.get("client_id") ?? "";
  const grant = f.get("grant_type");
  if (grant === "authorization_code") {
    const code = f.get("code") ?? "";
    const r = code ? await prisma.mcpAuthRequest.findUnique({ where: { codeHash: sha256(code) } }) : null;
    if (!r || !r.customerId || r.expiresAt <= new Date()) return bad("invalid_grant", "The code is wrong or expired.");
    if (r.usedAt) {
      // A code used twice: someone may have copied it. End everything this sign-in produced.
      await prisma.mcpToken.updateMany({ where: { grantId: r.id, revokedAt: null }, data: { revokedAt: new Date() } });
      return bad("invalid_grant", "The code was already used.");
    }
    if (clientId && clientId !== r.clientId) return bad("invalid_grant", "The code belongs to another app.");
    if ((f.get("redirect_uri") ?? r.redirectUri) !== r.redirectUri) return bad("invalid_grant", "redirect_uri doesn't match.");
    if (!pkceOk(f.get("code_verifier") ?? "", r.codeChallenge)) return bad("invalid_grant", "PKCE check failed.");
    const claimed = await prisma.mcpAuthRequest.updateMany({ where: { id: r.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) return bad("invalid_grant", "The code was already used.");
    return issue(r.clientId, r.customerId, r.id);
  }
  if (grant === "refresh_token") {
    const t = await prisma.mcpToken.findUnique({ where: { tokenHash: sha256(f.get("refresh_token") ?? "") } });
    if (!t || t.kind !== "refresh" || t.expiresAt <= new Date()) return bad("invalid_grant", "The refresh token is wrong or expired.");
    if (t.revokedAt) {
      // An old refresh token came back: it may have leaked. End the whole grant; the app signs in again.
      await prisma.mcpToken.updateMany({ where: { grantId: t.grantId, revokedAt: null }, data: { revokedAt: new Date() } });
      return bad("invalid_grant", "The refresh token was already used.");
    }
    if (clientId && clientId !== t.clientId) return bad("invalid_grant", "The token belongs to another app.");
    const claimed = await prisma.mcpToken.updateMany({ where: { id: t.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count !== 1) return bad("invalid_grant", "The refresh token was already used.");
    return issue(t.clientId, t.customerId, t.grantId);
  }
  return bad("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/** Ends the grant a token belongs to (RFC 7009: unknown tokens are not an error). */
export async function revoke(raw: string): Promise<void> {
  const t = raw ? await prisma.mcpToken.findUnique({ where: { tokenHash: sha256(raw) } }) : null;
  if (t) await prisma.mcpToken.updateMany({ where: { grantId: t.grantId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** The customer and app behind a Bearer header, or null. */
export async function bearer(header: string | null): Promise<{ customerId: string; clientId: string; token: string } | null> {
  const m = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(header ?? "");
  if (!m) return null;
  const t = await prisma.mcpToken.findUnique({ where: { tokenHash: sha256(m[1]) } });
  if (!t || t.kind !== "access" || t.revokedAt || t.expiresAt <= new Date()) return null;
  return { customerId: t.customerId, clientId: t.clientId, token: m[1] };
}

/** Apps connected to this customer's account (for the Connect page), newest first. */
export async function connectedApps(customerId: string) {
  const live = await prisma.mcpToken.findMany({ where: { customerId, kind: "refresh", revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
  const grants = new Map<string, { grantId: string; clientId: string; since: Date }>();
  for (const t of live) if (!grants.has(t.grantId)) grants.set(t.grantId, { grantId: t.grantId, clientId: t.clientId, since: t.createdAt });
  const clients = new Map((await prisma.mcpClient.findMany({ where: { id: { in: [...grants.values()].map((g) => g.clientId) } } })).map((c) => [c.id, c.name]));
  return [...grants.values()].map((g) => ({ ...g, name: clients.get(g.clientId) ?? "An app" }));
}

export async function disconnect(customerId: string, grantId: string): Promise<void> {
  await prisma.mcpToken.updateMany({ where: { customerId, grantId, revokedAt: null }, data: { revokedAt: new Date() } });
}
