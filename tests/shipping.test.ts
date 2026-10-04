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

test("originCandidates tries China first for Canada, then warehouses that stock everything", () => {
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: inv({ CN: 10, US: 3 }) }], "CA"), ["CN", "US"]);
  // a Canadian warehouse would come before the US one
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: inv({ CN: 10, US: 3, CA: 2 }) }], "CA"), ["CN", "CA", "US"]);
  // the US warehouse only counts when it covers the quantity
  assert.deepEqual(originCandidates([{ quantity: 5, inventoryJson: inv({ CN: 10, US: 3 }) }], "CA"), ["CN"]);
  // US addresses still prefer the US warehouse when it covers everything
  assert.deepEqual(originCandidates([{ quantity: 1, inventoryJson: inv({ CN: 10, US: 3 }) }], "US"), ["US", "CN"]);
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
