import { test } from "node:test";
import assert from "node:assert/strict";
import { allocatePrice, drawBox, simulate, type PoolVariant } from "../lib/mystery";

const pool: PoolVariant[] = Array.from({ length: 12 }, (_, i) => ({
  variantId: `v${i}`,
  productId: `p${i}`,
  title: `Item ${i}`,
  listCents: 1299 + i * 100, // $12.99 - $23.99 list
  costCents: 299 + i * 60, // $2.99 - $9.59 cost
  inStock: i !== 3,
}));
const rules = { priceCents: 4900, itemCount: 4, guaranteedValueCents: 6000, minProfitCents: 1000 };

test("every draw beats the guaranteed value, keeps the minimum profit and has distinct in-stock items", () => {
  for (let i = 0; i < 300; i++) {
    const d = drawBox(pool, rules)!;
    assert.ok(d, "draw failed");
    assert.equal(d.length, 4);
    assert.equal(new Set(d.map((x) => x.productId)).size, 4);
    assert.ok(d.reduce((n, x) => n + x.listCents, 0) >= 6000);
    assert.ok(4900 - d.reduce((n, x) => n + x.costCents, 0) >= 1000);
    assert.ok(d.every((x) => x.inStock));
  }
});

test("impossible rules return null instead of a bad box", () => {
  assert.equal(drawBox(pool, { ...rules, guaranteedValueCents: 20000 }), null);
  assert.equal(drawBox(pool, { ...rules, itemCount: 20 }), null);
  assert.equal(simulate(pool, { ...rules, minProfitCents: 4800 }).successRate, 0);
});

test("allocated item prices sum exactly to the box price", () => {
  const parts = allocatePrice(4900, [{ listCents: 1299 }, { listCents: 1599 }, { listCents: 2399 }]);
  assert.equal(parts.reduce((n, x) => n + x, 0), 4900);
});
