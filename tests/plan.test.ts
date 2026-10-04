// The subscription plan: $30/month with a free welcome box that keeps an 86% margin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LITE, DEFAULT_PLAN, liteAiBudgetMicros, maxBoxCostCents, maxItemListCents, normalizeLite, normalizePlan, planRules, stripeFeeCents } from "../lib/plan";
import { costMicros } from "../lib/ai-cost";
import { messagesFor } from "../lib/membership";
import { priceBand } from "../lib/box-builder";
import { drawBox, type PoolVariant } from "../lib/mystery";

test("the default plan is $30 with an 86% welcome-box margin", () => {
  assert.deepEqual(DEFAULT_PLAN, { priceCents: 3000, marginPct: 86 });
  assert.equal(maxBoxCostCents(DEFAULT_PLAN), 420); // products in the box cost at most $4.20
});

test("planRules: worth at least the price, products within the margin", () => {
  assert.deepEqual(planRules({ itemCount: 3 }, DEFAULT_PLAN), { priceCents: 3000, itemCount: 3, guaranteedValueCents: 3000, minProfitCents: 2580 });
});

test("the box builder looks for items listing at about $10-12 for a 3-item box", () => {
  assert.equal(maxItemListCents(DEFAULT_PLAN, 3), 1199); // $1.40 cost -> $11.99 list (cost + $10, .99)
  assert.deepEqual(priceBand(planRules({ itemCount: 3 }, DEFAULT_PLAN), maxItemListCents(DEFAULT_PLAN, 3)), { lo: 999, hi: 1199 });
});

test("draws never break the plan's margin", () => {
  const v = (id: string, cost: number, list: number): PoolVariant => ({ variantId: id, productId: id, title: id, costCents: cost, listCents: list, inStock: true });
  const rules = planRules({ itemCount: 3 }, DEFAULT_PLAN);
  const cheap = [v("a", 120, 1199), v("b", 130, 1199), v("c", 140, 1199), v("d", 100, 1099)];
  for (let i = 0; i < 50; i++) {
    const d = drawBox(cheap, rules)!;
    const cost = d.reduce((n, x) => n + x.costCents, 0);
    assert.ok(cost <= 420 && (3000 - cost) / 3000 >= 0.86, `cost ${cost}`);
    assert.ok(d.reduce((n, x) => n + x.listCents, 0) >= 3000);
  }
  // Too expensive for the margin: no box (shown as sold out) rather than a loss.
  assert.equal(drawBox([v("x", 900, 1999), v("y", 900, 1999), v("z", 900, 1999)], rules), null);
});

test("normalizePlan clamps silly values", () => {
  assert.deepEqual(normalizePlan({ priceCents: 1, marginPct: 150 }), { priceCents: 500, marginPct: 95 });
  assert.deepEqual(normalizePlan(null), DEFAULT_PLAN);
});

test("Lite at $5 with a 10% margin leaves $4.05 of AI per subscriber after Stripe's fee, and never loses money", () => {
  assert.equal(stripeFeeCents(500), 45); // 2.9% of $5 (14.5¢, rounded) + 30¢
  assert.deepEqual(DEFAULT_LITE, { enabled: true, priceCents: 500, marginPct: 10 });
  // 500 × 90% = 450¢, minus 45¢ fee = 405¢
  assert.equal(liteAiBudgetMicros(DEFAULT_LITE), 4_050_000);
  // Margin check: revenue 500, costs = 45 fee + 405 AI = 450 → 10% kept.
  assert.equal(Math.round((1 - (stripeFeeCents(500) + liteAiBudgetMicros(DEFAULT_LITE) / 10_000) / 500) * 100), 10);
  // The 86% version (25¢ of AI) is still possible from the admin.
  assert.equal(liteAiBudgetMicros(normalizeLite({ priceCents: 500, marginPct: 86 })), 250_000);
  // A price too low for the margin leaves nothing, never a negative budget.
  assert.equal(liteAiBudgetMicros(normalizeLite({ priceCents: 100, marginPct: 86 })), 0);
  assert.equal(normalizeLite({ enabled: false }).enabled, false);
});

test("AI cost is priced from the response's token counts", () => {
  // Sonnet 5.5: $2 in, $10 out, $0.20 cache read, $2.50 cache write per MTok (= micros per token).
  assert.equal(costMicros("claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000 }), 2000 + 5000 + 2000 + 5000);
  assert.equal(costMicros("claude-haiku-4-5-20251001", { input_tokens: 1000, output_tokens: 1000 }), 6000);
  // An unknown model is priced high, so margins are never overstated.
  assert.ok(costMicros("claude-future-9", { input_tokens: 1000, output_tokens: 0 }) >= 10_000);
  assert.equal(messagesFor(250_000, 40_000), 6);
  assert.equal(messagesFor(-5, 40_000), 0);
});
