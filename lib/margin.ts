// The floor under every price: what a sale must charge so it never loses money, even in the worst case for card
// processing (an international card on Stripe: about 2.9% + 1.5% + 30¢) and, for hotels billed to our account card
// in another currency, the conversion on that card. Our normal fee is usually above it; the floor only lifts big
// bookings, where a percentage fee below the processing rate would otherwise turn negative.
//
// CARD_WORST_PCT     worst-case card processing, % of the charge (default 4.4)
// CARD_FIXED_CENTS   fixed part per charge (default 30)

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** The least a sale costing `costCents` can charge without losing money (cents, not rounded to a whole unit). */
export function noLossCents(costCents: number, opts: { fixedCostCents?: number; extraPct?: number } = {}): number {
  const pct = Math.min(20, num(process.env.CARD_WORST_PCT, 4.4));
  const fixed = num(process.env.CARD_FIXED_CENTS, 30) + (opts.fixedCostCents ?? 0);
  return Math.ceil((costCents * (1 + (opts.extraPct ?? 0) / 100) + fixed) / (1 - pct / 100));
}

/** Stripe's fee on a charge in the worst case (an international card). */
export function worstCardFeeCents(chargeCents: number): number {
  const pct = Math.min(20, num(process.env.CARD_WORST_PCT, 4.4));
  return Math.ceil((chargeCents * pct) / 100) + num(process.env.CARD_FIXED_CENTS, 30);
}

/**
 * When a checkout stops being payable (Stripe's expires_at, unix seconds): just before the price it shows stops
 * holding (the airline's offer expiry, a hold's deadline), so nobody pays for a fare we can no longer book at that
 * price. Stripe needs it between 30 minutes and 24 hours away.
 */
export function checkoutExpiry(until?: string | Date | null, fallbackMin = 60): number {
  const now = Date.now();
  const want = until ? new Date(until).getTime() - 2 * 60_000 : now + fallbackMin * 60_000;
  const t = Math.min(Math.max(Number.isFinite(want) ? want : now + fallbackMin * 60_000, now + 31 * 60_000), now + 23 * 3600_000);
  return Math.floor(t / 1000);
}

/**
 * The bank's security check (3-D Secure) on flight card payments: FLIGHT_3DS = any (default: ask for it whenever
 * the card supports it, which moves fraud chargebacks to the bank), automatic (only when Stripe or the bank wants
 * it) or off.
 */
export function flight3ds(): { card: { request_three_d_secure: "any" | "automatic" } } | undefined {
  const v = (process.env.FLIGHT_3DS ?? "any").trim().toLowerCase();
  if (v === "off") return undefined;
  return { card: { request_three_d_secure: v === "automatic" ? "automatic" : "any" } };
}
