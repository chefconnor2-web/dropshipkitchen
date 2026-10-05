// Who may use the AI assistant, and how much. Subscribers get an AI cost budget per 30 days: Lite's (what
// keeps the Lite margin) and twice that on Full, shown as messages at the measured average cost of a message.
// The merchant can also set anyone's limit by hand. Everyone else gets a few free messages to try it, and can
// always search the catalog themselves.
import { prisma } from "@/lib/db";
import { COUNTED_ORDER } from "@/lib/customers";
import { getLitePlan, liteAiBudgetMicros, type LitePlan } from "@/lib/plan";

export const WINDOW_MS = 30 * 86_400_000;
const LIMITS_KEY = "ai.limits";

export interface SpendTier {
  minSpendCents: number;
  limit: number;
}
export interface LimitsConfig {
  /** Free AI messages for people without a subscription (ever, per browser). */
  freeMessages: number;
  /** Messages per 30 days for subscribers, by lifetime spend. */
  tiers: SpendTier[];
}

export const DEFAULT_LIMITS: LimitsConfig = {
  freeMessages: 3,
  tiers: [
    { minSpendCents: 0, limit: 100 },
    { minSpendCents: 25_000, limit: 300 },
    { minSpendCents: 100_000, limit: 1000 },
  ],
};

export function normalizeLimits(raw: Partial<LimitsConfig> | null | undefined): LimitsConfig {
  const free = Math.max(0, Math.min(1000, Math.round(Number(raw?.freeMessages ?? DEFAULT_LIMITS.freeMessages)) || 0));
  const tiers = (Array.isArray(raw?.tiers) ? raw!.tiers : DEFAULT_LIMITS.tiers)
    .map((t) => ({ minSpendCents: Math.max(0, Math.round(Number(t.minSpendCents) || 0)), limit: Math.max(0, Math.round(Number(t.limit) || 0)) }))
    .sort((a, b) => a.minSpendCents - b.minSpendCents);
  if (!tiers.length || tiers[0].minSpendCents > 0) tiers.unshift({ minSpendCents: 0, limit: tiers[0]?.limit ?? DEFAULT_LIMITS.tiers[0].limit });
  return { freeMessages: free, tiers };
}

export async function getLimits(): Promise<LimitsConfig> {
  const row = await prisma.setting.findUnique({ where: { key: LIMITS_KEY } });
  try {
    return normalizeLimits(row ? JSON.parse(row.value) : null);
  } catch {
    return DEFAULT_LIMITS;
  }
}

export async function saveLimits(c: LimitsConfig) {
  const value = JSON.stringify(normalizeLimits(c));
  await prisma.setting.upsert({ where: { key: LIMITS_KEY }, create: { key: LIMITS_KEY, value }, update: { value } });
}

/** The tier a lifetime spend falls in. */
export function tierFor(spendCents: number, tiers: SpendTier[]): SpendTier {
  return [...tiers].reverse().find((t) => spendCents >= t.minSpendCents) ?? tiers[0];
}

/** Paid, not refunded: orders (monthly box orders included) plus subscription months without a box. */
export async function lifetimeSpendCents(customerId: string): Promise<number> {
  const [orders, months] = await Promise.all([
    prisma.order.aggregate({ where: { customerId, ...COUNTED_ORDER }, _sum: { subtotalCents: true, shippingCents: true } }),
    prisma.subscriptionPayment.aggregate({ where: { customerId }, _sum: { amountCents: true } }),
  ]);
  return (orders._sum.subtotalCents ?? 0) + (orders._sum.shippingCents ?? 0) + (months._sum.amountCents ?? 0);
}

const LIVE_STATUSES = ["active", "trialing", "past_due"];

export async function activeSubscriptions(customerId: string) {
  return prisma.subscription.findMany({ where: { customerId, status: { in: LIVE_STATUSES } }, orderBy: { createdAt: "asc" } });
}

export interface Allowance {
  subscriber: boolean;
  limit: number;
  used: number;
  remaining: number;
  /** Why the limit is what it is, for the shopper and the admin. */
  basis: "free" | "custom" | "lite" | "full";
  spendCents: number;
  /** The subscription plan that sets the allowance, if any. */
  plan: "full" | "lite" | null;
}

/** Until enough messages have been measured, assume a message costs this much (deliberately on the high side). */
export const DEFAULT_MESSAGE_MICROS = 60_000;

/** The average cost of a recent AI message, in micro-dollars (measured; a cautious default until there's data). */
export async function averageMessageMicros(): Promise<{ micros: number; measured: number }> {
  const agg = await prisma.aiUsage.aggregate({ where: { costMicros: { not: null } }, orderBy: { createdAt: "desc" }, take: 300, _avg: { costMicros: true }, _count: { costMicros: true } });
  const measured = agg._count.costMicros ?? 0;
  return { micros: measured >= 10 ? Math.max(1, Math.ceil(agg._avg.costMicros ?? DEFAULT_MESSAGE_MICROS)) : DEFAULT_MESSAGE_MICROS, measured };
}

/** Messages a cost budget buys at the average cost (for display; the budget itself is what's enforced). */
export function messagesFor(budgetMicros: number, avgMicros: number): number {
  return Math.max(0, Math.floor(budgetMicros / Math.max(1, avgMicros)));
}

/** How many AI messages this person may still send. */
export async function aiAllowance(who: { customerId: string | null; visitorId: string | null }): Promise<Allowance> {
  const limits = await getLimits();
  const customer = who.customerId ? await prisma.customer.findUnique({ where: { id: who.customerId } }) : null;
  const subs = customer ? await activeSubscriptions(customer.id) : [];
  const subscriber = subs.length > 0;
  if (customer && subscriber) {
    // Someone with both plans gets the full one.
    const plan: "full" | "lite" = subs.some((s) => s.plan !== "lite") ? "full" : "lite";
    const since = new Date(Date.now() - WINDOW_MS);
    const spendCents = await lifetimeSpendCents(customer.id);
    // The merchant's own number for this person wins (a message count).
    if (customer.aiLimitOverride != null) {
      const used = await prisma.aiUsage.count({ where: { customerId: customer.id, createdAt: { gte: since } } });
      const limit = customer.aiLimitOverride;
      return { subscriber, plan, limit, used, remaining: Math.max(0, limit - used), basis: "custom", spendCents };
    }
    // Otherwise an AI cost budget per 30 days: Lite's, and twice that on Full. Capped, so no plan loses money.
    const [lite, avg, rows] = await Promise.all([
      getLitePlan(),
      averageMessageMicros(),
      prisma.aiUsage.aggregate({ where: { customerId: customer.id, createdAt: { gte: since } }, _sum: { costMicros: true }, _count: { _all: true, costMicros: true } }),
    ]);
    const budget = planAiBudgetMicros(plan, lite);
    // Messages from before costs were measured count at the average.
    const spent = (rows._sum.costMicros ?? 0) + (rows._count._all - (rows._count.costMicros ?? 0)) * avg.micros;
    const limit = messagesFor(budget, avg.micros);
    const remaining = messagesFor(budget - spent, avg.micros);
    return { subscriber, plan, limit, used: Math.max(0, limit - remaining), remaining, basis: plan, spendCents };
  }
  // Free trial: counted per browser and, once signed in, per account (so a new browser isn't a new trial).
  const or = [...(who.visitorId ? [{ visitorId: who.visitorId }] : []), ...(customer ? [{ customerId: customer.id }] : [])];
  const used = or.length ? await prisma.aiUsage.count({ where: { OR: or } }) : 0;
  const limit = customer?.aiLimitOverride ?? limits.freeMessages;
  return { subscriber: false, plan: null, limit, used, remaining: Math.max(0, limit - used), basis: customer?.aiLimitOverride != null ? "custom" : "free", spendCents: 0 };
}

/** Full gets this many times Lite's AI budget. */
export const FULL_USAGE_MULTIPLIER = 2;

/** A plan's AI cost budget per 30 days, in micro-dollars. */
export function planAiBudgetMicros(plan: "full" | "lite", lite: LitePlan): number {
  return liteAiBudgetMicros(lite) * (plan === "full" ? FULL_USAGE_MULTIPLIER : 1);
}

export async function recordAiUse(who: { customerId: string | null; visitorId: string | null; chatId?: string; costMicros?: number }) {
  await prisma.aiUsage.create({ data: { customerId: who.customerId, visitorId: who.visitorId, chatId: who.chatId ?? null, costMicros: who.costMicros ?? null } });
}

/** What to tell someone who has run out. `prices`: the full and Lite monthly prices, e.g. "$30.00" / "$5.00". */
export function limitMessage(a: Allowance, prices: { full?: string; lite?: string | null } = {}): string {
  if (a.plan === "lite")
    return `You've used this month's Lite plan. It refills over the month, or upgrade to Full${prices.full ? ` (${prices.full}/month)` : ""}: twice the usage, plus a surplus mystery box every month.`;
  if (a.subscriber)
    return `You've used this month's assistant time. It refills over the month. You can keep searching the catalog yourself any time.`;
  const options = [`Full${prices.full ? ` (${prices.full}/month)` : ""} with a surplus mystery box every month`, prices.lite ? `Lite (${prices.lite}/month)` : null].filter(Boolean).join(", or ");
  const pitch = `Keep going with ${options}, or search the catalog yourself for free.`;
  return a.basis === "custom" ? `That's the end of your AI preview. ${pitch}` : `That's the end of your free preview. ${pitch} Already subscribed? Sign in.`;
}
