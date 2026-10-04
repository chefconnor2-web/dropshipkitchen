// Bulk pricing for the whole transaction. Small orders pay list price (30% over cost, at least $10 profit
// per unit). Bigger orders are priced as one deal: the markup steps down as the order's cost grows and as
// a line's quantity grows, and the whole order only has to clear a minimum profit, not $10 per unit.
// Order prices can only be lower than list, never higher. Tune the numbers here.

/** Orders under both thresholds pay list price. */
export const BULK_MIN_COST_CENTS = 100_00;
export const BULK_MIN_UNITS = 5;

/** Markup on cost by the order's total supplier cost (largest first). */
export const ORDER_TIERS: Array<{ minCostCents: number; markup: number }> = [
  { minCostCents: 5000_00, markup: 0.12 },
  { minCostCents: 2000_00, markup: 0.15 },
  { minCostCents: 500_00, markup: 0.2 },
  { minCostCents: 0, markup: 0.25 },
];
/** Extra markup off a line by its quantity. */
export const QTY_BONUS: Array<{ minQty: number; off: number }> = [
  { minQty: 100, off: 0.02 },
  { minQty: 25, off: 0.01 },
];
export const FLOOR_MARKUP = 0.1;
/** The least the store makes on any bulk order. */
export const MIN_ORDER_PROFIT_CENTS = 10_00;

export interface PriceLine {
  listCents: number;
  costCents: number | null | undefined;
  quantity: number;
}

export interface PricedOrder {
  /** Unit price per line, same order as the input. */
  unitCents: number[];
  listTotalCents: number;
  totalCents: number;
  savingsCents: number;
  /** Markup applied to the order (before quantity bonuses), or null at list price. */
  markup: number | null;
}

export function orderMarkup(costCents: number): number {
  return ORDER_TIERS.find((t) => costCents >= t.minCostCents)!.markup;
}

/** Prices a whole cart/order. Lines without a known supplier cost always pay list price. */
export function priceOrder(lines: PriceLine[]): PricedOrder {
  const listTotalCents = lines.reduce((n, l) => n + l.listCents * l.quantity, 0);
  const costed = lines.filter((l) => l.costCents != null);
  const costTotal = costed.reduce((n, l) => n + l.costCents! * l.quantity, 0);
  const units = costed.reduce((n, l) => n + l.quantity, 0);
  const atList: PricedOrder = { unitCents: lines.map((l) => l.listCents), listTotalCents, totalCents: listTotalCents, savingsCents: 0, markup: null };
  if (!costed.length || (costTotal < BULK_MIN_COST_CENTS && units < BULK_MIN_UNITS)) return atList;

  const markup = orderMarkup(costTotal);
  const unitCents = lines.map((l) => {
    if (l.costCents == null) return l.listCents;
    const off = QTY_BONUS.find((b) => l.quantity >= b.minQty)?.off ?? 0;
    // Whole basis points so float noise (1.11 * 10000 = 11100.000000000002) can't add a cent.
    const bp = Math.round(Math.max(FLOOR_MARKUP, markup - off) * 10_000);
    return Math.min(l.listCents, Math.ceil((l.costCents * (10_000 + bp)) / 10_000));
  });

  // Top up to the minimum order profit, spread over the units, never above list.
  const profit = () => lines.reduce((n, l, i) => n + (l.costCents == null ? 0 : (unitCents[i] - l.costCents) * l.quantity), 0);
  let shortfall = MIN_ORDER_PROFIT_CENTS - profit();
  for (let pass = 0; shortfall > 0 && pass < 5; pass++) {
    const room = lines.map((l, i) => (l.costCents == null ? 0 : l.listCents - unitCents[i]));
    const roomUnits = lines.reduce((n, l, i) => n + (room[i] > 0 ? l.quantity : 0), 0);
    if (!roomUnits) break;
    const perUnit = Math.ceil(shortfall / roomUnits);
    lines.forEach((l, i) => {
      if (room[i] > 0) unitCents[i] += Math.min(room[i], perUnit);
    });
    shortfall = MIN_ORDER_PROFIT_CENTS - profit();
  }

  const totalCents = lines.reduce((n, l, i) => n + unitCents[i] * l.quantity, 0);
  return { unitCents, listTotalCents, totalCents, savingsCents: listTotalCents - totalCents, markup };
}

/** One line for product pages and the assistant. */
export function bulkPricingLabel(): string {
  return `Bulk pricing: orders of ${BULK_MIN_UNITS}+ units or $${BULK_MIN_COST_CENTS / 100}+ get lower margins automatically, down to ${Math.round(
    ORDER_TIERS[0].markup * 100,
  )}% on the biggest orders`;
}
