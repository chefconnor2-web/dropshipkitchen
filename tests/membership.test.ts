// AI limits by spend tier, and the signed account cookie.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, limitMessage, normalizeLimits, tierFor } from "../lib/membership";
import { signValue, verifyValue } from "../lib/session";

test("tierFor picks the highest tier the spend reaches", () => {
  const tiers = [
    { minSpendCents: 0, limit: 100 },
    { minSpendCents: 25_000, limit: 300 },
    { minSpendCents: 100_000, limit: 1000 },
  ];
  assert.equal(tierFor(0, tiers).limit, 100);
  assert.equal(tierFor(24_999, tiers).limit, 100);
  assert.equal(tierFor(25_000, tiers).limit, 300);
  assert.equal(tierFor(5_000_000, tiers).limit, 1000);
});

test("normalizeLimits sorts tiers, starts them at $0 and clamps bad input", () => {
  const c = normalizeLimits({ freeMessages: -4, tiers: [{ minSpendCents: 50_000, limit: 500 }, { minSpendCents: 10_000, limit: 200 }] });
  assert.equal(c.freeMessages, 0);
  assert.deepEqual(
    c.tiers.map((t) => [t.minSpendCents, t.limit]),
    [
      [0, 200],
      [10_000, 200],
      [50_000, 500],
    ],
  );
  assert.deepEqual(normalizeLimits(null), DEFAULT_LIMITS);
  assert.equal(normalizeLimits({ freeMessages: 99999 }).freeMessages, 1000);
});

test("limitMessage points non-subscribers to a subscription", () => {
  const base = { used: 5, remaining: 0, spendCents: 0 };
  assert.match(limitMessage({ ...base, subscriber: false, limit: 3, basis: "free" }, "$30.00"), /3 free AI messages.*Subscribe for \$30\.00\/month.*free mystery box/);
  assert.match(limitMessage({ ...base, subscriber: true, limit: 100, basis: "tier" }), /all 100 AI messages for this month/);
});

test("signed cookie values verify, and tampering fails", () => {
  const signed = signValue("cust_123", "k1");
  assert.equal(verifyValue(signed, "k1"), "cust_123");
  assert.equal(verifyValue(signed, "other-key"), null);
  assert.equal(verifyValue(signed.replace("cust_123", "cust_999"), "k1"), null);
  assert.equal(verifyValue("garbage", "k1"), null);
});
