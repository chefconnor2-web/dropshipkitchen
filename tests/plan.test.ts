// The subscription plan: $30/month with a free welcome box that keeps an 86% margin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PLAN, maxBoxCostCents, maxItemListCents, normalizePlan, planRules } from "../lib/plan";
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
