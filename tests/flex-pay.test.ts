// Pay later (Klarna, Affirm, Afterpay) only where it fits the currency and our margin covers its fee.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flexPayTypes } from "../lib/flex-pay";

test("offered with cards when the margin covers the pay-later fee", () => {
  // $200 sale on a $150 cost: $50 margin vs about $13 fee + $5 reserve.
  assert.deepEqual(flexPayTypes(20000, 15000, "USD"), ["card", "klarna", "affirm", "afterpay_clearpay"]);
  assert.deepEqual(flexPayTypes(20000, 15000, "EUR"), ["card", "klarna"]);
  assert.deepEqual(flexPayTypes(20000, 15000, "AUD"), ["card", "klarna", "afterpay_clearpay"]);
});

test("cards only when it would cost us money, for an unsupported currency, or when switched off", () => {
  // $1,000 sale on a $955 cost: $45 margin vs about $65 fee.
  assert.equal(flexPayTypes(100000, 95500, "USD"), null);
  assert.equal(flexPayTypes(20000, 15000, "JPY"), null);
  process.env.FLEX_PAY = "off";
  assert.equal(flexPayTypes(20000, 15000, "USD"), null);
  delete process.env.FLEX_PAY;
});
