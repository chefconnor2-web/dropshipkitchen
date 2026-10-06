// Warehouse rule: US stock ships to the US only; China stock ships to the US and Canada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canShipFrom, originsCode, parseOrigins, usOnly, warehouseLabel, warehousesFrom } from "../lib/warehouses";

const rows = (o: Record<string, number>) => JSON.stringify(Object.entries(o).map(([countryCode, totalInventoryNum]) => ({ countryCode, totalInventoryNum })));

test("canShipFrom", () => {
  assert.equal(canShipFrom("US", "US"), true);
  assert.equal(canShipFrom("US", "CA"), false);
  assert.equal(canShipFrom("CN", "CA"), true);
  assert.equal(canShipFrom("CN", "US"), true);
});

test("warehouse labels", () => {
  const usOnlyW = warehousesFrom([rows({ US: 12, CN: 0 })]);
  assert.equal(usOnly(usOnlyW), true);
  assert.equal(warehouseLabel(usOnlyW), "US warehouse · ships to US addresses only");
  assert.equal(warehouseLabel(warehousesFrom([rows({ CN: 900 })])), "China warehouse · ships to the US and Canada");
  // any variant in China makes the product reachable from China
  assert.equal(warehouseLabel(warehousesFrom([rows({ US: 4 }), rows({ CN: 2 })])), "In the US and China warehouses · ships to the US and Canada");
  assert.equal(warehouseLabel(warehousesFrom([null])), null);
  assert.equal(originsCode(usOnlyW), "US");
  assert.deepEqual(parseOrigins("US,CN"), { us: true, cn: true, known: true });
  assert.equal(parseOrigins(null).known, false);
});

test("the cart explains a US-warehouse-only item to a Canadian shopper", async () => {
  const { blockedMessage } = await import("../lib/shipping");
  const names: Record<string, string> = { A: "Grill set", B: "Big battery" };
  const msg = blockedMessage(["A", "B"], (v) => names[v], "CA", (v) => v === "A");
  assert.match(msg!, /^Grill set is in our US warehouse, which ships to US addresses only\. Big battery can’t ship to Canada from any of our warehouses\. Remove them/);
  // US shoppers never get the US-only wording
  assert.match(blockedMessage(["A"], (v) => names[v], "US", () => true)!, /^Grill set can’t ship to United States/);
});

test("sea shipping: China (or unknown) stock to Canada can go by boat; US-only stock can't", async () => {
  const { seaEligible } = await import("../lib/warehouses");
  assert.equal(seaEligible(warehousesFrom([rows({ CN: 50 })]), "CA"), true);
  assert.equal(seaEligible(warehousesFrom([null]), "CA"), true);
  assert.equal(seaEligible(warehousesFrom([rows({ US: 9 })]), "CA"), false);
  assert.equal(seaEligible(warehousesFrom([rows({ CN: 50 })]), "US"), false);
test("badge answers follow the warehouse rule, with China as the default", async () => {
  const { shipsByRule } = await import("../lib/ship-check");
  assert.equal(shipsByRule(null, "CA"), true); // unknown: China, CJ's default
  assert.equal(shipsByRule("?", "CA"), true);
  assert.equal(shipsByRule("CN", "CA"), true);
  assert.equal(shipsByRule("US", "CA"), false);
  assert.equal(shipsByRule("US", "US"), true);
  assert.equal(shipsByRule("US,CN", "CA"), true);
});
