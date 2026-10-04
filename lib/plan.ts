// The subscription plan: one monthly price that includes a mystery box, and the margin every box must keep
// at that price. A box drawn for a subscriber never costs (in products) more than price × (1 − margin);
// shipping is charged on top, at cost. Boxes are always worth at least the price at our list prices.
import { prisma } from "@/lib/db";
import { retailCents } from "@/lib/money";
import type { BoxRules } from "@/lib/mystery";

export interface Plan {
  priceCents: number;
  /** Required gross margin on the box's products, in percent (shipping excluded). */
  marginPct: number;
}

export const DEFAULT_PLAN: Plan = { priceCents: 3000, marginPct: 86 };
const KEY = "subscription.plan";

export function normalizePlan(raw: Partial<Plan> | null | undefined): Plan {
  const price = Math.round(Number(raw?.priceCents ?? DEFAULT_PLAN.priceCents));
  const margin = Number(raw?.marginPct ?? DEFAULT_PLAN.marginPct);
  return {
    priceCents: Number.isFinite(price) ? Math.min(100_000, Math.max(500, price)) : DEFAULT_PLAN.priceCents,
    marginPct: Number.isFinite(margin) ? Math.min(95, Math.max(0, margin)) : DEFAULT_PLAN.marginPct,
  };
}

export async function getPlan(): Promise<Plan> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } }).catch(() => null);
  try {
    return normalizePlan(row ? JSON.parse(row.value) : null);
  } catch {
    return DEFAULT_PLAN;
  }
}

export async function savePlan(p: Plan) {
  const value = JSON.stringify(normalizePlan(p));
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

/** The most a subscriber's box may cost us in products. */
export function maxBoxCostCents(plan: Plan): number {
  return Math.floor(plan.priceCents * (1 - plan.marginPct / 100));
}

/** Draw rules for a box sold on the plan: the plan's price and margin, worth at least the price. */
export function planRules(box: { itemCount: number }, plan: Plan): BoxRules {
  return {
    priceCents: plan.priceCents,
    itemCount: box.itemCount,
    guaranteedValueCents: plan.priceCents,
    minProfitCents: plan.priceCents - maxBoxCostCents(plan),
  };
}

/** The highest list price an item can have and still fit the plan's cost (for the AI box builder). */
export function maxItemListCents(plan: Plan, itemCount: number): number {
  return retailCents(Math.floor(maxBoxCostCents(plan) / Math.max(1, itemCount)));
}
