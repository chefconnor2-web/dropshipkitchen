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

// ---------- Lite: AI only, no box ----------
// A cheaper monthly plan with a smaller AI allowance. What the AI may cost us per subscriber per month is
// price × (1 − margin), less Stripe's fee on the charge; each Lite subscriber's measured AI spend is capped
// at that, so the margin holds however long or short their messages are.

export interface LitePlan {
  enabled: boolean;
  priceCents: number;
  /** Required margin after AI cost and Stripe's fee, in percent. */
  marginPct: number;
}

export const DEFAULT_LITE: LitePlan = { enabled: true, priceCents: 500, marginPct: 86 };
const LITE_KEY = "subscription.lite";

export function normalizeLite(raw: Partial<LitePlan> | null | undefined): LitePlan {
  const price = Math.round(Number(raw?.priceCents ?? DEFAULT_LITE.priceCents));
  const margin = Number(raw?.marginPct ?? DEFAULT_LITE.marginPct);
  return {
    enabled: raw?.enabled !== false,
    priceCents: Number.isFinite(price) ? Math.min(100_000, Math.max(100, price)) : DEFAULT_LITE.priceCents,
    marginPct: Number.isFinite(margin) ? Math.min(99, Math.max(0, margin)) : DEFAULT_LITE.marginPct,
  };
}

export async function getLitePlan(): Promise<LitePlan> {
  const row = await prisma.setting.findUnique({ where: { key: LITE_KEY } }).catch(() => null);
  try {
    return normalizeLite(row ? JSON.parse(row.value) : null);
  } catch {
    return DEFAULT_LITE;
  }
}

export async function saveLitePlan(p: LitePlan) {
  const value = JSON.stringify(normalizeLite(p));
  await prisma.setting.upsert({ where: { key: LITE_KEY }, create: { key: LITE_KEY, value }, update: { value } });
}

/** Stripe's standard card fee on one charge: 2.9% + 30¢. */
export function stripeFeeCents(chargeCents: number): number {
  return Math.round(chargeCents * 0.029) + 30;
}

/** What one Lite subscriber's AI may cost us per 30 days, in micro-dollars (never negative). */
export function liteAiBudgetMicros(p: LitePlan): number {
  const cents = p.priceCents * (1 - p.marginPct / 100) - stripeFeeCents(p.priceCents);
  return Math.max(0, Math.floor(cents * 10_000));
}
