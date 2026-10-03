export function formatMoney(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** Parse CJ's price values (number, "12.84", or a range "1.20 -- 3.40") into cents (lowest value). */
export function priceToCents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  const m = String(v).match(/\d+(?:\.\d+)?/);
  return m ? Math.round(parseFloat(m[0]) * 100) : null;
}

export function dollarsToCents(input: string): number | null {
  const n = Number(String(input).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/**
 * Markup for a supplier cost: the configured markup for small items, tapering for expensive ones
 * so a $230 power station isn't priced at $700. `base` is DEFAULT_MARKUP (3 by default).
 */
export function tieredMarkup(supplierCents: number | null, base: number): number {
  if (!supplierCents || supplierCents < 1500) return base;
  if (supplierCents < 6000) return Math.min(base, 2.5);
  return Math.min(base, 2);
}

/** Retail price suggestion: supplier cost x markup, ending in .99. */
export function suggestRetailCents(supplierCents: number | null, markup: number): number {
  if (!supplierCents) return 1999;
  const raw = Math.ceil((supplierCents * markup) / 100);
  return Math.max(raw, 1) * 100 - 1;
}

/** Store pricing rule: 30% over the supplier cost, but never less than $10 profit per unit. */
export const MARKUP = 0.3;
export const MIN_PROFIT_CENTS = 1000;

/** Retail price for a supplier cost under the store rule, rounded UP to the next .99 so it never drops below the rule. */
export function retailCents(supplierCents: number): number {
  const target = Math.max(Math.ceil(supplierCents * (1 + MARKUP)), supplierCents + MIN_PROFIT_CENTS);
  return Math.ceil((target + 1) / 100) * 100 - 1;
}
