import { test } from "node:test";
import assert from "node:assert/strict";
import { retailCents } from "../lib/money";

test("cheap items get at least $10 profit", () => {
  for (const cost of [100, 499, 1000, 3333]) {
    const p = retailCents(cost);
    assert.ok(p - cost >= 1000, `cost ${cost} → ${p}`);
    assert.equal(p % 100, 99);
  }
  assert.equal(retailCents(500), 1599); // $5 cost → $15 target → $15.99
});

test("pricier items get at least 30% markup, rounded up to .99", () => {
  for (const cost of [3334, 5000, 12345, 23000]) {
    const p = retailCents(cost);
    assert.ok(p >= Math.ceil(cost * 1.3), `cost ${cost} → ${p}`);
    assert.ok(p - Math.ceil(cost * 1.3) < 100);
  }
  assert.equal(retailCents(10000), 13099); // $100 → $130 target → $130.99
});

import { priceOrder } from "../lib/volume";

test("small orders pay list price", () => {
  const r = priceOrder([{ listCents: 1599, costCents: 500, quantity: 2 }]);
  assert.deepEqual(r.unitCents, [1599]);
  assert.equal(r.savingsCents, 0);
});

test("bulk of cheap items: whole order only needs the minimum profit", () => {
  // 100 bags at $0.50 cost list at $10.99 each; as one $50 order at 25% - 2pt markup they're ~$0.62,
  // topped up so the order still makes at least $10.
  const r = priceOrder([{ listCents: 1099, costCents: 50, quantity: 100 }]);
  const profit = (r.unitCents[0] - 50) * 100;
  assert.ok(profit >= 1000, `profit ${profit}`);
  assert.ok(r.unitCents[0] < 100, `unit ${r.unitCents[0]}`);
});

test("markup steps down with order size and never goes above list", () => {
  const big = priceOrder([{ listCents: 13099, costCents: 10000, quantity: 60 }]); // $6,000 cost: 12%
  assert.equal(big.markup, 0.12);
  assert.equal(big.unitCents[0], 11100); // 12% minus the 25+ units bonus
  const mid = priceOrder([{ listCents: 13099, costCents: 10000, quantity: 6 }]); // $600 cost: 20%
  assert.equal(mid.unitCents[0], 12000);
  for (const r of [big, mid]) assert.ok(r.totalCents <= r.listTotalCents);
});

test("lines without a known cost keep list price", () => {
  const r = priceOrder([{ listCents: 2000, costCents: null, quantity: 10 }, { listCents: 13099, costCents: 10000, quantity: 6 }]);
  assert.equal(r.unitCents[0], 2000);
});
