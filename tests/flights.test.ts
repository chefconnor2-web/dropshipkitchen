// Flights connector: Duffel offers → cards with our fee, the shopper's filters, ranking, and input checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isoMinutes, keep, priceWithFee, rank, toCard } from "../lib/flights";
import { parseSearch, describe as describeCard } from "../lib/connectors/duffel";
import { dayShift, durationLabel, flightPrice, stopsLabel } from "../lib/flights-shared";
import type { DuffelOffer } from "../lib/duffel";

const seg = (from: string, to: string, dep: string, arr: string, checked = 1) => ({
  departing_at: dep,
  arriving_at: arr,
  origin: { iata_code: from, city_name: from },
  destination: { iata_code: to, city_name: to },
  marketing_carrier: { name: "Duffel Airways", iata_code: "ZZ" },
  marketing_carrier_flight_number: "101",
  passengers: [{ baggages: [{ type: "checked", quantity: checked }, { type: "carry_on", quantity: 1 }], cabin_class_marketing_name: "Economy" }],
});
const offer = (id: string, amount: string, segs: ReturnType<typeof seg>[], duration: string): DuffelOffer => ({
  id,
  total_amount: amount,
  total_currency: "USD",
  expires_at: "2099-01-01T00:00:00Z",
  owner: { name: "Duffel Airways", iata_code: "ZZ", logo_symbol_url: null },
  slices: [{ origin: segs[0].origin, destination: segs[segs.length - 1].destination, duration, segments: segs }],
  passengers: [{ id: "pas_1", type: "adult" }],
  conditions: { refund_before_departure: { allowed: false }, change_before_departure: { allowed: true, penalty_amount: "50", penalty_currency: "USD" } },
});

const fee = { fixedCents: 15_00, pct: 3 };

test("our fee is always on top, rounded up to a whole unit", () => {
  assert.equal(priceWithFee("500.00", fee), 530_00); // 500 + 15 + 3% (15) = 530
  assert.equal(priceWithFee("100.10", fee), 119_00); // 100.10 × 1.03 + 15 = 118.10 → 119
  assert.ok(priceWithFee("1", fee) > 100);
});

test("durations from Duffel's ISO format", () => {
  assert.equal(isoMinutes("PT11H30M"), 690);
  assert.equal(isoMinutes("P1DT2H"), 1560);
  assert.equal(isoMinutes(null), 0);
  assert.equal(durationLabel(690), "11h 30m");
  assert.equal(durationLabel(45), "45m");
});

test("an offer becomes a card", () => {
  const c = toCard(offer("off_1", "812.40", [seg("YVR", "HND", "2026-11-03T13:05:00", "2026-11-04T15:35:00")], "PT10H30M"), fee);
  assert.equal(c.priceCents, 852_00);
  assert.equal(c.slices[0].stops, 0);
  assert.equal(stopsLabel(c.slices[0]), "Nonstop");
  assert.equal(dayShift(c.slices[0].depart, c.slices[0].arrive), "+1");
  assert.equal(c.checkedBags, 1);
  assert.equal(c.refundable, false);
  assert.equal(c.changeable, true);
  assert.equal(flightPrice(c), "$852");
  const d = describeCard(c);
  assert.deepEqual(d.flights, ["YVR 13:05 → HND 15:35+1 (2026-11-03), 10h 30m, Nonstop"]);
});

test("filters: bags, stops and departure times", () => {
  const oneStop = toCard(offer("off_2", "500", [seg("YVR", "SEA", "2026-11-03T06:00:00", "2026-11-03T07:00:00", 0), seg("SEA", "HND", "2026-11-03T09:00:00", "2026-11-04T13:00:00", 0)], "PT14H"), fee);
  const base = { departAfter: "", departBefore: "", checkedBag: false, maxStops: null };
  assert.equal(keep(oneStop, base), true);
  assert.equal(keep(oneStop, { ...base, checkedBag: true }), false);
  assert.equal(keep(oneStop, { ...base, maxStops: 0 }), false);
  assert.equal(keep(oneStop, { ...base, departAfter: "08:00" }), false);
  assert.equal(keep(oneStop, { ...base, departBefore: "08:00" }), true);
  assert.equal(stopsLabel(oneStop.slices[0]), "1 stop · SEA");
});

test("ranking: best value, then cheapest and fastest, no duplicates", () => {
  const cheapSlow = toCard(offer("off_cheap", "400", [seg("YVR", "SEA", "2026-11-03T06:00:00", "2026-11-03T07:00:00"), seg("SEA", "HND", "2026-11-03T15:00:00", "2026-11-04T19:00:00")], "PT20H"), fee);
  const fast = toCard(offer("off_fast", "900", [seg("YVR", "HND", "2026-11-03T13:00:00", "2026-11-04T15:00:00")], "PT10H"), fee);
  const middle = toCard(offer("off_mid", "480", [seg("YVR", "HND", "2026-11-03T12:00:00", "2026-11-04T14:30:00")], "PT10H30M"), fee);
  const picks = rank([cheapSlow, fast, middle]);
  assert.deepEqual(picks.map((p) => p.id), ["off_mid", "off_cheap", "off_fast"]);
  assert.equal(rank([]).length, 0);
  assert.equal(rank([fast]).length, 1);
});

test("searches from the model are checked before calling Duffel", () => {
  const today = "2026-10-07";
  const good = parseSearch({ label: "Exact", slices: [{ origin: "yvr", destination: "tyo", date: "2026-11-03" }], adults: 2, child_ages: [4], cabin: "business", max_stops: -1, depart_after: "", depart_before: "", checked_bag: true }, today);
  assert.ok(typeof good !== "string");
  if (typeof good !== "string") {
    assert.equal(good.slices[0].origin, "YVR");
    assert.equal(good.maxStops, null);
    assert.deepEqual(good.childAges, [4]);
    assert.equal(good.cabin, "business");
  }
  assert.match(String(parseSearch({ slices: [{ origin: "Vancouver", destination: "TYO", date: "2026-11-03" }] }, today)), /3-letter/);
  assert.match(String(parseSearch({ slices: [{ origin: "YVR", destination: "TYO", date: "2026-01-03" }] }, today)), /past/);
  assert.match(String(parseSearch({ slices: [] }, today)), /at least one/);
});
