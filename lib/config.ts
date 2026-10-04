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
    // CJ enforces per-account QPS limits; calls start at least this far apart.
    minIntervalMs: num("CJ_MIN_INTERVAL_MS", 1100),
    // Calls in flight at once (each still starts minIntervalMs after the last). 1 = strictly one at a time.
    maxConcurrent: num("CJ_MAX_CONCURRENT", 3),
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
  email: {
    // Resend (resend.com). Without a key, emails are rendered and logged in the admin but not sent.
    resendApiKey: process.env.RESEND_API_KEY?.trim() || "",
    // A sender on a domain verified in Resend. Until one is, Resend only allows onboarding@resend.dev,
    // which can deliver to the Resend account owner's own address only.
    from: process.env.EMAIL_FROM?.trim() || "",
    // Where new-order alerts go, and the Reply-To on customer emails.
    storeEmail: process.env.STORE_EMAIL?.trim() || "",
  },
  siteUrl: (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, ""),
  storeName: process.env.STORE_NAME || "Tetherless",
  // mock (default): never sends orders to CJ · sandbox: CJ sandbox orders only (no charge, no shipping)
  // · live: also real CJ orders, paid from the CJ balance, each one confirmed by the merchant.
  supplierMode: (process.env.SUPPLIER_MODE || "mock").toLowerCase(),
};

/** Initials of the store name ("Tetherless" → "T", "Outpost Power Co." → "OC"): logo mark, SKU and order prefixes. */
export function storeInitials(): string {
  const words = config.storeName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pick = words.length > 2 ? [words[0], words[words.length - 1]] : words;
  return pick.map((w) => w[0].toUpperCase()).join("").slice(0, 3) || "ST";
}

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
