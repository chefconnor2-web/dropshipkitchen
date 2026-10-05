// Shipping from the right warehouse, and naming what can't ship. No CJ calls: CJ is simulated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { originCandidates, stockByCountry } from "../lib/fulfillment";
import { planParcels, type ParcelOption } from "../lib/parcels";
import { blockedMessage } from "../lib/shipping";

const inv = (rows: Record<string, number>) => JSON.stringify(Object.entries(rows).map(([countryCode, n]) => ({ countryCode, totalInventoryNum: n })));

test("stockByCountry sums CJ's warehouse rows per country", () => {
  const m = stockByCountry(JSON.stringify([{ countryCode: "CN", totalInventoryNum: 5 }, { countryCode: "CN", storageNum: 2 }, { countryCode: "US", totalInventoryNum: 1 }]));
  assert.equal(m.get("CN"), 7);
  assert.equal(m.get("US"), 1);
  assert.equal(stockByCountry("garbage").size, 0);
});

test("originCandidates: China for Canada, never the US warehouse; US addresses prefer the US warehouse", () => {
  // US warehouse stock ships to US addresses only.
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: inv({ CN: 10, US: 3 }) }], "CA"), ["CN"]);
  // a Canadian warehouse would come after China (same country), never the US one
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: inv({ CN: 10, US: 3, CA: 2 }) }], "CA"), ["CN", "CA"]);
  // US addresses still prefer the US warehouse when it covers everything
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: inv({ CN: 10, US: 3 }) }], "US"), ["US", "CN"]);
  // the US warehouse only counts when it covers the quantity
  assert.deepEqual(originCandidates([{ quantity: 5, inventoryJson: inv({ CN: 10, US: 3 }) }], "US"), ["CN"]);
});

test("a US-warehouse-only product can't go to Canada, but can go to the US", () => {
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: inv({ US: 40 }) }], "CA"), []);
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: inv({ US: 40 }) }], "US"), ["US"]);
  // unknown stock: China, CJ's default, for either country
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: null }], "CA"), ["CN"]);
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: null }], "US"), ["CN"]);
});

const opt = (cents: number): ParcelOption[] => [{ method: "Line", cents, minDays: 7, maxDays: 12 }];

test("a battery CJ won't send from China ships from the US warehouse in its own parcel", async () => {
  // Simulated CJ: the battery has no route from CN to CA; everything else ships from CN; the US ships anything.
  const quoter = async (from: string, _to: string, _zip: string | undefined, items: Array<{ vid: string; quantity: number }>) =>
    from === "CN" && items.some((i) => i.vid === "BATTERY") ? [] : opt(from === "US" ? 4000 : 1500);
  const r = await planParcels(
    [
      { vid: "BATTERY", quantity: 1, weightGrams: 5000, origins: ["CN", "US"] },
      { vid: "CHARGER", quantity: 1, weightGrams: 800, origins: ["CN"] },
      { vid: "TOOLS", quantity: 2, weightGrams: 300, origins: ["CN"] },
    ],
    "CN",
    "CA",
    undefined,
    quoter,
  );
  assert.deepEqual(r.blocked, []);
  assert.ok(r.parcels);
  const battery = r.parcels!.find((p) => p.items.some((i) => i.vid === "BATTERY"))!;
  assert.equal(battery.from, "US");
  assert.deepEqual(battery.items, [{ vid: "BATTERY", quantity: 1 }]); // never mixed with China stock
  assert.ok(r.parcels!.filter((p) => p !== battery).every((p) => p.from === "CN"));
});

test("planParcels names every product that can't ship from anywhere", async () => {
  const quoter = async (_from: string, _to: string, _zip: string | undefined, items: Array<{ vid: string; quantity: number }>) =>
    items.some((i) => i.vid === "BATTERY" || i.vid === "SCOOTER") ? [] : opt(900);
  const r = await planParcels(
    [
      { vid: "BATTERY", quantity: 1, origins: ["CN", "US"] },
      { vid: "TOOLS", quantity: 1, origins: ["CN"] },
      { vid: "SCOOTER", quantity: 1, origins: ["CN"] },
    ],
    "CN",
    "CA",
    undefined,
    quoter,
  );
  assert.equal(r.parcels, null);
  assert.deepEqual(r.blocked, ["BATTERY", "SCOOTER"]);
});

test("blockedMessage names the products and the country", () => {
  const names: Record<string, string> = { B: "48V 20Ah battery", S: "Scooter" };
  assert.equal(blockedMessage([], (v) => names[v], "CA"), null);
  assert.match(blockedMessage(["B"], (v) => names[v], "CA")!, /^48V 20Ah battery can’t ship to Canada .*Remove it/);
  assert.match(blockedMessage(["B", "S"], (v) => names[v], "CA")!, /^48V 20Ah battery and Scooter can’t ship to Canada .*Remove them/);
  assert.match(blockedMessage(["X"], () => undefined, "US")!, /^An item in a mystery box can’t ship to United States/);
});

import { fitEstimate } from "../lib/shipping";

test("fitEstimate draws a line through earlier quotes by weight", () => {
  const pts = [
    { g: 500, c: 1000, min: 7, max: 12 },
    { g: 1500, c: 2000, min: 8, max: 14 },
    { g: 2500, c: 3000, min: 9, max: 15 },
  ];
  assert.deepEqual(fitEstimate(pts, 2000), { cents: 2500, minDays: 8, maxDays: 14 });
  // never below the cheapest quote seen
  assert.equal(fitEstimate(pts, 10)!.cents, 1000);
  // no data, no estimate
  assert.equal(fitEstimate([], 1000), null);
});

test("fitEstimate scales gently from a single earlier quote", () => {
  assert.equal(fitEstimate([{ g: 1000, c: 1000, min: null, max: null }], 4000)!.cents, 2000);
  assert.equal(fitEstimate([{ g: 1000, c: 1000, min: null, max: null }], 4000)!.minDays, null);
});

test("fitEstimate ignores a falling trend (heavier never estimates cheaper)", () => {
  const pts = [
    { g: 500, c: 3000, min: 7, max: 12 },
    { g: 3000, c: 1000, min: 7, max: 12 },
  ];
  assert.equal(fitEstimate(pts, 3000)!.cents, 2000); // flat at the average, not below it
});
