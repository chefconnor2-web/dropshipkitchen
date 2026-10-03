// Central runtime configuration. Everything that could spend money is gated here.

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  cj: {
    apiKey: process.env.CJ_API_KEY?.trim() || "",
    baseUrl: (process.env.CJ_API_BASE_URL || "https://developers.cjdropshipping.com/api2.0/v1").replace(/\/+$/, ""),
    // CJ enforces per-account QPS limits; serialise calls with at least this gap.
    minIntervalMs: num("CJ_MIN_INTERVAL_MS", 1100),
    timeoutMs: num("CJ_TIMEOUT_MS", 20000),
    // Retries for HTTP 429 (CJ also rate-limits per source IP, which shared egress IPs can hit).
    rateLimitRetries: num("CJ_RATE_LIMIT_RETRIES", 2),
  },
  inventory: {
    // Product pages use the cached value; add-to-cart and checkout re-query CJ when older than this.
    ttlMinutes: num("INVENTORY_TTL_MINUTES", 30),
    lowStockThreshold: num("LOW_STOCK_THRESHOLD", 20),
  },
  pricing: {
    defaultMarkup: num("DEFAULT_MARKUP", 3),
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY?.trim() || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || "",
  },
  receiving: {
    // Case-sticker and product-date photos are read by Claude when this is set; otherwise fields are typed in.
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || "",
    model: process.env.RECEIVING_MODEL?.trim() || "claude-opus-5-5",
    // Photos live on disk (on Fly: the /data volume).
    uploadDir: process.env.UPLOAD_DIR?.trim() || "./uploads",
    // "Use first" list on /admin/receiving covers products expiring within this many days.
    expiringSoonDays: num("RECEIVING_EXPIRING_DAYS", 3),
  },
  siteUrl: (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, ""),
  storeName: process.env.STORE_NAME || "Chef Supply",
  // Only "mock" is implemented. Live CJ purchasing is intentionally absent from this build.
  supplierMode: (process.env.SUPPLIER_MODE || "mock").toLowerCase(),
};

export function cjConfigured(): boolean {
  return config.cj.apiKey.length > 0;
}

export function stripeKeyProblem(): string | null {
  const k = config.stripe.secretKey;
  if (!k) return "STRIPE_SECRET_KEY is not set.";
  if (!k.startsWith("sk_test_") && !k.startsWith("rk_test_"))
    return "Only Stripe TEST keys (sk_test_…) are accepted during the proof phase.";
  return null;
}

export function labelReaderConfigured(): boolean {
  return config.receiving.anthropicApiKey.length > 0;
}
