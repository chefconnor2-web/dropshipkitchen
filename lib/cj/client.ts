// Official CJdropshipping API V2 client (https://developers.cjdropshipping.com/api2.0/v1).
//
// Endpoints used:
//   POST /authentication/getAccessToken     { apiKey }
//   POST /authentication/refreshAccessToken { refreshToken }
//   GET  /product/listV2                    keyWord, page, size
//   GET  /product/query                     pid
//   GET  /product/variant/query             pid
//   GET  /product/variant/queryByVid        vid
//   GET  /product/stock/queryByVid          vid
//   POST /product/sourcing/create           ask CJ to source a product it doesn't list yet
//   POST /product/sourcing/query            status of those requests
//   POST /logistic/freightCalculate         shipping options and cost for exact VIDs
//   POST /shopping/order/createOrderV3      create a CJ order (payType 3 = create only, never auto-pay)
//   PATCH /shopping/order/confirmOrder      CREATED → UNPAID, required before payment
//   POST /shopping/sandbox/simulatePay      simulated payment for a sandbox order (no charge)
//   POST /shopping/pay/payBalance           pay a created order from the CJ balance (by order id)
//   POST /shopping/pay/payBalanceV2         the same, for a parent order (by shipment order id)
//   GET  /shopping/pay/getBalance           CJ account balance
//   GET  /shopping/order/getOrderDetail     order status and tracking
// Only lib/fulfillment.ts calls the order and payment endpoints, and only behind SUPPLIER_MODE.
//
// Every call is written to the CjApiCall table (path, HTTP status, CJ code, CJ requestId, timing)
// so the admin can see that data came from CJ's official API.

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { makeThrottle } from "./lanes";
import { processSingleton } from "@/lib/singleton";
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

// ---- throttle: CJ rate-limits per account, so pace call starts in-process (urgent calls first) ----
const throttled = processSingleton("cj-throttle", () => makeThrottle(() => config.cj.minIntervalMs, () => config.cj.maxConcurrent));

async function rawCall<T>(
  method: "GET" | "POST" | "PATCH",
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
  method: "GET" | "POST" | "PATCH",
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

    // Logged after the slot is free: the database write shouldn't hold up the next CJ call.
    void prisma.cjApiCall
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

// CJ limits token requests: calls that need a new token at the same moment share one request.
const tokenInflight = processSingleton("cj-token-inflight", () => ({ current: null as Promise<string> | null }));

export async function getAccessToken(forceNew = false): Promise<string> {
  if (!config.cj.apiKey) throw new CjApiError("CJ_API_KEY is not configured.");
  const stored = forceNew ? null : await loadToken();
  if (stored?.accessToken && notExpired(stored.accessTokenExpiryDate)) return stored.accessToken;
  tokenInflight.current ??= fetchToken(stored).finally(() => (tokenInflight.current = null));
  return tokenInflight.current;
}

async function fetchToken(stored: StoredToken | null): Promise<string> {
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

async function authed<T>(
  path: string,
  query: Record<string, string | number | undefined>,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: unknown,
): Promise<CjEnvelope<T>> {
  const token = await getAccessToken();
  try {
    return await rawCall<T>(method, path, { query, body, token });
  } catch (e) {
    const authFailure =
      e instanceof CjApiError && (e.httpStatus === 401 || (e.cjCode !== undefined && AUTH_ERROR_CODES.has(e.cjCode)));
    if (!authFailure) throw e;
    await prisma.setting.deleteMany({ where: { key: TOKEN_KEY } });
    return rawCall<T>(method, path, { query, body, token: await getAccessToken(true) });
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

export interface CjSourcingRequest {
  productName: string;
  productImage: string;
  productUrl?: string;
  remark?: string;
  /** Target price in USD. */
  price?: number;
}

/** Ask CJ's agents to find and list a product CJ doesn't carry yet. Returns CJ's sourcing id. */
export async function createSourcing(req: CjSourcingRequest) {
  return authed<{ cjSourcingId?: string; result?: string }>("/product/sourcing/create", {}, "POST", req);
}

/** Status of earlier sourcing requests, by CJ sourcing id. */
export async function querySourcing(sourceIds: string[]) {
  return authed<unknown>("/product/sourcing/query", {}, "POST", { sourceIds });
}

export interface CjFreightOption {
  logisticName: string;
  logisticPrice: number; // USD
  logisticAging?: string; // days, e.g. "7-12"
}

export async function freightCalculate(req: {
  startCountryCode: string;
  endCountryCode: string;
  zip?: string;
  products: Array<{ vid: string; quantity: number }>;
}) {
  return authed<CjFreightOption[]>("/logistic/freightCalculate", {}, "POST", req);
}

export interface CjCreateOrderData {
  orderId?: string;
  orderNumber?: string;
  shipmentOrderId?: string;
  orderAmount?: number | string;
  actualPayment?: number | string;
  postageAmount?: number | string;
  productAmount?: number | string;
  orderStatus?: string;
  interceptOrderReasons?: Array<{ code: number; message: string }>;
}

/** Creates a CJ order without paying for it (payType 3). Payment is a separate, explicit call. */
export async function createOrderV3(body: Record<string, unknown>) {
  return authed<CjCreateOrderData>("/shopping/order/createOrderV3", {}, "POST", { ...body, payType: 3 });
}

/** Moves a created order (CREATED) to UNPAID so it can be paid. */
export async function confirmOrder(orderId: string) {
  return authed<string>("/shopping/order/confirmOrder", {}, "PATCH", { orderId });
}

/** Simulated payment for a sandbox order (isSandbox=1). Never charges anything. */
export async function sandboxSimulatePay(orderId: string) {
  return authed<boolean>("/shopping/sandbox/simulatePay", {}, "POST", { orderId });
}

/** Pays one CJ order from the balance. For a parent order with several sub-orders use payBalanceV2. */
export async function payBalance(orderId: string) {
  return authed<null>("/shopping/pay/payBalance", {}, "POST", { orderId });
}

export async function payBalanceV2(shipmentOrderId: string) {
  return authed<null>("/shopping/pay/payBalanceV2", {}, "POST", { shipmentOrderId });
}

export async function getBalance() {
  return authed<{ amount: number; freezeAmount?: number | null }>("/shopping/pay/getBalance", {});
}

export async function getOrderDetail(orderId: string) {
  return authed<Record<string, unknown>>("/shopping/order/getOrderDetail", { orderId });
}

/** Connection test: obtains (or reuses) a token and performs one tiny catalog read. */
export async function testConnection() {
  const env = await listProductsV2("kitchen", 1, 1);
  return { requestId: env.requestId ?? null, checkedAt: new Date() };
}
