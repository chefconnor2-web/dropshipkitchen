// What the plan picker shows: each plan's price and whether Lite is offered. Never message counts.
import { getLitePlan, getPlan } from "@/lib/plan";

export interface PlanOffer {
  lite: { enabled: boolean; priceCents: number };
  full: { priceCents: number };
}

export async function planOffer(): Promise<PlanOffer> {
  const [plan, lite] = await Promise.all([getPlan(), getLitePlan()]);
  return { lite: { enabled: lite.enabled, priceCents: lite.priceCents }, full: { priceCents: plan.priceCents } };
}
