// Mystery boxes: drawing each box's contents. Code, not the AI, enforces the rules on every draw:
// - the items are worth at least the box's guaranteed value at our list prices (no box is worth less),
// - the store keeps at least the box's minimum profit after supplier cost,
// - items are in stock, all different products, and similar in value (no rare "jackpot" items, which
//   would make a paid chance-based box look like a lottery).

import { prisma } from "@/lib/db";

export interface PoolVariant {
  variantId: string;
  productId: string;
  title: string;
  listCents: number;
  costCents: number;
  inStock: boolean;
}

/** Items in a box may differ in list price by at most this factor (keeps every box comparable). */
export const MAX_VALUE_SPREAD = 3;
const DRAW_ATTEMPTS = 600;

export async function loadPool(boxId: string): Promise<PoolVariant[]> {
  const rows = await prisma.mysteryBoxPoolItem.findMany({
    where: { boxId },
    include: { variant: { include: { product: true, offer: { include: { cjSupplierVariant: true } } } } },
  });
  return rows
    .filter((r) => r.variant.enabled && r.variant.product.status === "PUBLISHED" && r.variant.offer?.cjSupplierVariant.supplierPriceCents != null)
    .map((r) => ({
      variantId: r.variant.id,
      productId: r.variant.productId,
      title: r.variant.product.title,
      listCents: r.variant.priceCents,
      costCents: r.variant.offer!.cjSupplierVariant.supplierPriceCents!,
      inStock: (r.variant.offer!.cjSupplierVariant.inventoryTotal ?? 0) > 0,
    }));
}

function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

export interface BoxRules {
  priceCents: number;
  itemCount: number;
  guaranteedValueCents: number;
  minProfitCents: number;
}

/** A random draw that satisfies every rule, or null when the pool can't make one right now. */
export function drawBox(pool: PoolVariant[], rules: BoxRules, exclude: Set<string> = new Set()): PoolVariant[] | null {
  // One option per product, in stock only.
  const byProduct = new Map<string, PoolVariant[]>();
  for (const v of pool) if (v.inStock && !exclude.has(v.variantId)) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);
  const products = [...byProduct.values()];
  if (products.length < rules.itemCount) return null;
  const maxCost = rules.priceCents - rules.minProfitCents;
  for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt++) {
    const pick = shuffle(products)
      .slice(0, rules.itemCount)
      .map((opts) => opts[Math.floor(Math.random() * opts.length)]);
    const value = pick.reduce((n, v) => n + v.listCents, 0);
    const cost = pick.reduce((n, v) => n + v.costCents, 0);
    const lo = Math.min(...pick.map((v) => v.listCents));
    const hi = Math.max(...pick.map((v) => v.listCents));
    if (value >= rules.guaranteedValueCents && cost <= maxCost && hi <= lo * MAX_VALUE_SPREAD) return pick;
  }
  return null;
}

/** How often a pool can make a valid box, and what boxes look like on average. */
export function simulate(pool: PoolVariant[], rules: BoxRules, runs = 200) {
  let ok = 0;
  let value = 0;
  let profit = 0;
  for (let i = 0; i < runs; i++) {
    const d = drawBox(pool, rules);
    if (!d) continue;
    ok++;
    value += d.reduce((n, v) => n + v.listCents, 0);
    profit += rules.priceCents - d.reduce((n, v) => n + v.costCents, 0);
  }
  return {
    successRate: ok / runs,
    avgValueCents: ok ? Math.round(value / ok) : 0,
    avgProfitCents: ok ? Math.round(profit / ok) : 0,
    inStockProducts: new Set(pool.filter((v) => v.inStock).map((v) => v.productId)).size,
  };
}

/** Spreads the box price over its items in proportion to their list price (sums exactly to the box price). */
export function allocatePrice(priceCents: number, items: Array<{ listCents: number }>): number[] {
  const total = items.reduce((n, i) => n + i.listCents, 0) || 1;
  const out = items.map((i) => Math.floor((priceCents * i.listCents) / total));
  out[0] += priceCents - out.reduce((n, x) => n + x, 0);
  return out;
}
