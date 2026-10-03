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
