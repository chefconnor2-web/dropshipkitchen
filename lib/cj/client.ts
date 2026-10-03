// Official CJdropshipping API V2 client (https://developers.cjdropshipping.com/api2.0/v1).
//
// Endpoints used (all read-only — nothing in this file can place or pay for a CJ order):
//   POST /authentication/getAccessToken     { apiKey }
//   POST /authentication/refreshAccessToken { refreshToken }
//   GET  /product/listV2                    keyWord, page, size
//   GET  /product/query                     pid
//   GET  /product/variant/query             pid
//   GET  /product/variant/queryByVid        vid
//   GET  /product/stock/queryByVid          vid
//
// Every call is written to the CjApiCall table (path, HTTP status, CJ code, CJ requestId, timing)
// so the admin can see that data came from CJ's official API.

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import type {
  CjEnvelope,
  CjListV2Data,
  CjProductDetail,
  CjStockEntry,
  CjTokenData,
  CjVariant,
} from "./types";

export class CjApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly cjCode?: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "CjApiError";
  }
}

const TOKEN_KEY = "cj.token";

// ---- throttle: CJ rate-limits per account, so serialise calls in-process ----
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCallAt + config.cj.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastCallAt = Date.now();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

async function rawCall<T>(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown; token?: string } = {},
): Promise<CjEnvelope<T>> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") qs.set(k, String(v));
  const url = `${config.cj.baseUrl}${path}${qs.size ? `?${qs}` : ""}`;

  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce<T>(method, path, url, qs, opts);
    } catch (e) {
      const limited = e instanceof CjApiError && e.httpStatus === 429;
      if (!limited || attempt >= config.cj.rateLimitRetries) throw e;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** attempt)));
    }
  }
}

function callOnce<T>(
  method: "GET" | "POST",
  path: string,
  url: string,
  qs: URLSearchParams,
  opts: { body?: unknown; token?: string },
): Promise<CjEnvelope<T>> {
  return throttled(async () => {
    const started = Date.now();
    let httpStatus: number | undefined;
    let env: CjEnvelope<T> | undefined;
    let failure: string | undefined;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(opts.token ? { "CJ-Access-Token": opts.token } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(config.cj.timeoutMs),
        cache: "no-store",
      });
      httpStatus = res.status;
      const text = await res.text();
      try {
        env = JSON.parse(text) as CjEnvelope<T>;
      } catch {
        failure = `Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`;
      }
      if (env && !(env.result === true || env.code === 200)) failure = env.message || `CJ code ${env.code}`;
      if (!failure && !res.ok) failure = `HTTP ${res.status}`;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }

    await prisma.cjApiCall
      .create({
        data: {
          method,
          path,
          query: qs.size ? qs.toString() : null,
          httpStatus: httpStatus ?? null,
          cjCode: typeof env?.code === "number" ? env.code : null,
          ok: !failure,
          message: failure ?? env?.message ?? null,
          requestId: env?.requestId ?? null,
          durationMs: Date.now() - started,
        },
      })
      .catch(() => undefined);

    if (failure || !env) throw new CjApiError(failure ?? "Empty response", httpStatus, env?.code, env?.requestId);
    return env;
  });
}

// ---- access token (CJ limits getAccessToken calls, so it's persisted and reused) ----

type StoredToken = CjTokenData & { apiKeyFingerprint: string };

function fingerprint(key: string) {
  return key.slice(0, 4) + "…" + key.slice(-4);
}

async function loadToken(): Promise<StoredToken | null> {
  const row = await prisma.setting.findUnique({ where: { key: TOKEN_KEY } });
  if (!row) return null;
  try {
    const t = JSON.parse(row.value) as StoredToken;
    return t.apiKeyFingerprint === fingerprint(config.cj.apiKey) ? t : null;
  } catch {
    return null;
  }
}

async function saveToken(t: CjTokenData) {
  const value = JSON.stringify({ ...t, apiKeyFingerprint: fingerprint(config.cj.apiKey) });
  await prisma.setting.upsert({ where: { key: TOKEN_KEY }, update: { value }, create: { key: TOKEN_KEY, value } });
}

function notExpired(date?: string, marginMs = 60 * 60 * 1000): boolean {
  if (!date) return true; // unknown expiry: try it; a failure clears it
  const t = Date.parse(date.replace(" ", "T"));
  return Number.isNaN(t) ? true : t - marginMs > Date.now();
}

export async function getAccessToken(forceNew = false): Promise<string> {
  if (!config.cj.apiKey) throw new CjApiError("CJ_API_KEY is not configured.");
  const stored = forceNew ? null : await loadToken();
  if (stored?.accessToken && notExpired(stored.accessTokenExpiryDate)) return stored.accessToken;

  if (stored?.refreshToken && notExpired(stored.refreshTokenExpiryDate)) {
    try {
      const env = await rawCall<CjTokenData>("POST", "/authentication/refreshAccessToken", {
        body: { refreshToken: stored.refreshToken },
      });
      if (env.data?.accessToken) {
        await saveToken(env.data);
        return env.data.accessToken;
      }
    } catch {
      /* fall through to a fresh token */
    }
  }

  const env = await rawCall<CjTokenData>("POST", "/authentication/getAccessToken", {
    body: { apiKey: config.cj.apiKey },
  });
  if (!env.data?.accessToken) throw new CjApiError("CJ returned no accessToken", undefined, env.code, env.requestId);
  await saveToken(env.data);
  return env.data.accessToken;
}

const AUTH_ERROR_CODES = new Set([1600001, 1600002, 1600003]);

async function authed<T>(path: string, query: Record<string, string | number | undefined>): Promise<CjEnvelope<T>> {
  const token = await getAccessToken();
  try {
    return await rawCall<T>("GET", path, { query, token });
  } catch (e) {
    const authFailure =
      e instanceof CjApiError && (e.httpStatus === 401 || (e.cjCode !== undefined && AUTH_ERROR_CODES.has(e.cjCode)));
    if (!authFailure) throw e;
    await prisma.setting.deleteMany({ where: { key: TOKEN_KEY } });
    return rawCall<T>("GET", path, { query, token: await getAccessToken(true) });
  }
}

// ---- public API ----

export async function listProductsV2(keyWord: string, page = 1, size = 20) {
  return authed<CjListV2Data>("/product/listV2", { keyWord, page, size });
}

export async function getProductDetail(pid: string) {
  return authed<CjProductDetail>("/product/query", { pid });
}

export async function getVariantsByPid(pid: string) {
  return authed<CjVariant[]>("/product/variant/query", { pid });
}

export async function getVariantByVid(vid: string) {
  return authed<CjVariant>("/product/variant/queryByVid", { vid });
}

export async function getStockByVid(vid: string) {
  return authed<CjStockEntry[]>("/product/stock/queryByVid", { vid });
}

/** Connection test: obtains (or reuses) a token and performs one tiny catalog read. */
export async function testConnection() {
  const env = await listProductsV2("kitchen", 1, 1);
  return { requestId: env.requestId ?? null, checkedAt: new Date() };
}
