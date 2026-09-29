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

/** Retail price suggestion: supplier cost x markup, ending in .99. */
export function suggestRetailCents(supplierCents: number | null, markup: number): number {
  if (!supplierCents) return 1999;
  const raw = Math.ceil((supplierCents * markup) / 100);
  return Math.max(raw, 1) * 100 - 1;
}
