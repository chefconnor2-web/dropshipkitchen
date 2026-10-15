// Money guards: the no-loss price floor, when a checkout stops being payable, and 3-D Secure on flights.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutExpiry, flight3ds, noLossCents } from "../lib/margin";
import { priceWithFee } from "../lib/flights";

test("the floor covers worst-case card fees (and extras) so a sale never loses money", () => {
  const cost = 2000_00;
  const floor = noLossCents(cost, { fixedCostCents: 3_00 });
  // What we keep after a 4.4% + 30¢ card fee and the $3 supplier fee is never less than the cost.
  assert.ok(floor - Math.ceil(floor * 0.044) - 30 - 3_00 >= cost);
  assert.ok(noLossCents(cost, { extraPct: 3 }) > noLossCents(cost));
});

test("big flights are lifted to the floor; small ones keep the normal fee", () => {
  assert.equal(priceWithFee("200"), 221_00); // 200 × 1.03 + 15 = 221, above the floor
  const big = priceWithFee("2000");
  assert.ok(big > 2000_00 * 1.03 + 15_00); // 2075 would lose money on an international card
  assert.ok(big - Math.ceil(big * 0.044) - 30 - 3_00 >= 2000_00);
});

test("a checkout stops being payable just before the fare does, within Stripe's 30 min – 24 h", () => {
  const now = Date.now() / 1000;
  const soon = checkoutExpiry(new Date(Date.now() + 10 * 60_000).toISOString());
  assert.ok(soon >= now + 30 * 60 && soon <= now + 32 * 60); // too soon for Stripe: its minimum
  const inTwoHours = checkoutExpiry(new Date(Date.now() + 2 * 3600_000));
  assert.ok(Math.abs(inTwoHours - (now + 2 * 3600 - 120)) < 5); // two minutes before the fare expires
  const far = checkoutExpiry(new Date(Date.now() + 5 * 86400_000));
  assert.ok(far <= now + 24 * 3600); // never past Stripe's 24 hours
  assert.ok(Math.abs(checkoutExpiry(null, 60) - (now + 3600)) < 5);
});

test("flights ask for 3-D Secure unless turned down", () => {
  assert.deepEqual(flight3ds(), { card: { request_three_d_secure: "any" } });
  process.env.FLIGHT_3DS = "automatic";
  assert.deepEqual(flight3ds(), { card: { request_three_d_secure: "automatic" } });
  process.env.FLIGHT_3DS = "off";
  assert.equal(flight3ds(), undefined);
  delete process.env.FLIGHT_3DS;
});
