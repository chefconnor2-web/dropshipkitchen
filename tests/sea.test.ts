// Sea shipping to Canada: priced from the merchant's rate card, offered only when the whole order can sail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canSail, seaPriceCents, SEA_METHOD } from "../lib/sea";
import { daysLabel } from "../lib/shipping";

const rows = (o: Record<string, number>) => JSON.stringify(Object.entries(o).map(([countryCode, totalInventoryNum]) => ({ countryCode, totalInventoryNum })));
const rates = { perKgCents: 450, minCents: 150_00, perOrderCents: 120_00, bufferPct: 20 };

test("sea price: rate card plus buffer, rounded up to a dollar", () => {
  // 30 kg × $4.50 = $135 → minimum $150, + $120 per order = $270, + 20% = $324
  assert.equal(seaPriceCents(30_000, rates), 324_00);
  // 100 kg × $4.50 = $450 + $120 = $570, + 20% = $684
  assert.equal(seaPriceCents(100_000, rates), 684_00);
  // never below cost: a fraction of a dollar rounds up
  assert.equal(seaPriceCents(100_100, rates) >= 684_00 + 54, true);
  assert.equal(seaPriceCents(100_100, rates) % 100, 0);
  assert.equal(seaPriceCents(30_000, { ...rates, bufferPct: 0 }), 270_00);
});

test("only whole orders that can leave China for Canada sail", () => {
  const battery = { quantity: 2, inventoryJson: rows({ CN: 50 }), weightGrams: 30_000 };
  assert.equal(canSail([battery], "CA"), true);
  assert.equal(canSail([battery], "US"), false, "sea is a Canada route");
  assert.equal(canSail([{ ...battery, inventoryJson: null }], "CA"), true, "unknown stock: China, CJ's default");
  assert.equal(canSail([battery, { quantity: 1, inventoryJson: rows({ US: 9, CN: 0 }), weightGrams: 500 }], "CA"), false, "US-only item can't go");
  assert.equal(canSail([battery, { quantity: 1, inventoryJson: rows({ CA: 9 }), weightGrams: 500 }], "CA"), false, "Canada-only stock isn't in China");
  assert.equal(canSail([{ ...battery, weightGrams: null }], "CA"), false, "no weight, no price");
  assert.equal(canSail([], "CA"), false);
});

test("sea tier reads as weeks by boat", () => {
  assert.equal(daysLabel({ minDays: 20, maxDays: 35, method: SEA_METHOD }), "about 4–7 weeks by boat");
  assert.equal(daysLabel({ minDays: 5, maxDays: 10, method: "CJPacket" }), "5–10 business days");
});
