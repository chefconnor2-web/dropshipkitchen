// Who may use the AI assistant, and how much. Subscribers get a monthly message allowance that grows with
// how much they've spent (tiers the merchant sets); the merchant can also set anyone's limit by hand.
// Everyone else gets a few free messages to try it.
import { prisma } from "@/lib/db";
import { COUNTED_ORDER } from "@/lib/customers";

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
  freeMessages: 5,
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

/** Paid, not refunded: orders (subscription boxes included). */
export async function lifetimeSpendCents(customerId: string): Promise<number> {
  const agg = await prisma.order.aggregate({ where: { customerId, ...COUNTED_ORDER }, _sum: { subtotalCents: true, shippingCents: true } });
  return (agg._sum.subtotalCents ?? 0) + (agg._sum.shippingCents ?? 0);
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
  basis: "free" | "tier" | "custom";
  spendCents: number;
}

/** How many AI messages this person may still send. */
export async function aiAllowance(who: { customerId: string | null; visitorId: string | null }): Promise<Allowance> {
  const limits = await getLimits();
  const customer = who.customerId ? await prisma.customer.findUnique({ where: { id: who.customerId } }) : null;
  const subscriber = customer ? (await activeSubscriptions(customer.id)).length > 0 : false;
  if (customer && subscriber) {
    const since = new Date(Date.now() - WINDOW_MS);
    const used = await prisma.aiUsage.count({ where: { customerId: customer.id, createdAt: { gte: since } } });
    const spendCents = await lifetimeSpendCents(customer.id);
    const custom = customer.aiLimitOverride;
    const limit = custom ?? tierFor(spendCents, limits.tiers).limit;
    return { subscriber, limit, used, remaining: Math.max(0, limit - used), basis: custom != null ? "custom" : "tier", spendCents };
  }
  // Free trial: counted per browser and, once signed in, per account (so a new browser isn't a new trial).
  const or = [...(who.visitorId ? [{ visitorId: who.visitorId }] : []), ...(customer ? [{ customerId: customer.id }] : [])];
  const used = or.length ? await prisma.aiUsage.count({ where: { OR: or } }) : 0;
  const limit = customer?.aiLimitOverride ?? limits.freeMessages;
  return { subscriber: false, limit, used, remaining: Math.max(0, limit - used), basis: customer?.aiLimitOverride != null ? "custom" : "free", spendCents: 0 };
}

export async function recordAiUse(who: { customerId: string | null; visitorId: string | null; chatId?: string }) {
  await prisma.aiUsage.create({ data: { customerId: who.customerId, visitorId: who.visitorId, chatId: who.chatId ?? null } });
}

/** What to tell someone who has run out. */
export function limitMessage(a: Allowance): string {
  if (a.subscriber)
    return `You've used all ${a.limit} AI messages for this month. Your allowance refills as older messages pass 30 days, and it grows as you spend more with us.`;
  return a.basis === "custom"
    ? "You've used your AI messages. Subscribe to a mystery box to keep going."
    : `You've used your ${a.limit} free AI messages. Subscribe to a mystery box to keep using the assistant (sign in if you already have).`;
}
