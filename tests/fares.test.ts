// Fare types (Basic, Standard, Flex…) of the same flights grouped on one card, and the fare filter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupFares, keep, rank, toCard } from "../lib/flights";
import { describe as describeCard, parseSearch } from "../lib/connectors/duffel";
import { ruleLabel } from "../lib/flights-shared";

// These tests are about fare grouping, not pricing: no cost floor, so prices are the fares themselves.
process.env.CARD_WORST_PCT = "0";
process.env.CARD_FIXED_CENTS = "0";
process.env.DUFFEL_ORDER_FEE_CENTS = "0";
import type { DuffelOffer } from "../lib/duffel";

const seg = (dep: string, arr: string, checked: number, num = "101") => ({
  departing_at: dep,
  arriving_at: arr,
  origin: { iata_code: "YYZ", city_name: "Toronto" },
  destination: { iata_code: "MIA", city_name: "Miami" },
  marketing_carrier: { name: "Air Canada", iata_code: "AC" },
  marketing_carrier_flight_number: num,
  passengers: [{ baggages: [{ type: "checked", quantity: checked }, { type: "carry_on", quantity: 1 }], cabin_class_marketing_name: "Economy" }],
});
type Cond = { allowed: boolean; penalty_amount?: string; penalty_currency?: string };
const offer = (id: string, amount: string, brand: string, checked: number, change: Cond, refund: Cond, num = "101"): DuffelOffer => ({
  id,
  total_amount: amount,
  total_currency: "USD",
  expires_at: "2099-01-01T00:00:00Z",
  owner: { name: "Air Canada", iata_code: "AC", logo_symbol_url: null },
  slices: [{ origin: { iata_code: "YYZ" }, destination: { iata_code: "MIA" }, duration: "PT3H15M", fare_brand_name: brand, segments: [seg("2026-10-23T08:05:00", "2026-10-23T11:20:00", checked, num)] }],
  passengers: [{ id: "pas_1", type: "adult" }],
  conditions: { change_before_departure: change, refund_before_departure: refund },
});
const fee = { fixedCents: 0, pct: 0 };
const cards = [
  toCard(offer("off_basic", "400", "Basic", 0, { allowed: false }, { allowed: false }), fee),
  toCard(offer("off_std", "450", "Standard", 1, { allowed: true, penalty_amount: "75", penalty_currency: "USD" }, { allowed: false }), fee),
  toCard(offer("off_flex", "540", "Flex", 1, { allowed: true, penalty_amount: "0" }, { allowed: true, penalty_amount: "0" }), fee),
  toCard(offer("off_flex2", "560", "Flex", 1, { allowed: true, penalty_amount: "0" }, { allowed: true, penalty_amount: "0" }), fee), // a dearer copy
  toCard(offer("off_other", "380", "Basic", 0, { allowed: false }, { allowed: false }, "999"), fee), // a different flight
];
const any = { departAfter: "", departBefore: "", checkedBag: false, maxStops: null, fare: "" as const };

test("one card per flight, carrying its fare types cheapest first (dearer duplicates dropped)", () => {
  const g = groupFares(cards, (c) => keep(c, any));
  assert.equal(g.length, 2);
  const ac101 = g.find((c) => c.slices[0].segments[0].flight === "AC101")!;
  assert.equal(ac101.id, "off_basic");
  assert.deepEqual(ac101.fares!.map((f) => [f.brand, f.priceCents]), [["Basic", 40000], ["Standard", 45000], ["Flex", 54000]]);
  assert.equal(ruleLabel(ac101.fares![1].changeRule, "changes"), "Changes USD 75");
  assert.equal(ruleLabel(ac101.fares![2].refundRule, "refund"), "Refundable");
  // The other flight has one fare: no picker.
  assert.equal(g.find((c) => c.slices[0].segments[0].flight === "AC999")!.fares, undefined);
  // Ranking sees two distinct trips, not five fares.
  assert.equal(rank(g).length, 2);
});

test("a flexible-fare search shows the cheapest fare that allows changes or refunds, with the others still listed", () => {
  const changeable = groupFares(cards, (c) => keep(c, { ...any, fare: "changeable" }));
  assert.deepEqual(changeable.map((c) => c.id), ["off_std"]);
  assert.equal(changeable[0].fares!.length, 3);
  const refundable = groupFares(cards, (c) => keep(c, { ...any, fare: "refundable" }));
  assert.deepEqual(refundable.map((c) => c.id), ["off_flex"]);
});

test("the planner sees every fare option, and the search takes a fare preference", () => {
  const g = groupFares(cards).find((c) => c.id === "off_basic")!;
  const d = describeCard(g) as { fare_options: string[]; rules: string };
  assert.equal(d.rules, "No changes, No refund");
  assert.match(d.fare_options[2], /^Flex: \$540, 1 checked bag, Free changes, Refundable$/);
  const s = parseSearch({ slices: [{ origin: "YYZ", destination: "MIA", date: "2026-10-23" }], fare: "refundable" }, "2026-10-14");
  assert.equal(typeof s === "string" ? s : s.fare, "refundable");
});

test("holdable fares: only when the airline doesn't need instant payment", async () => {
  const { canHold } = await import("../lib/flight-booking");
  const o = offer("off_hold", "400", "Basic", 0, { allowed: false }, { allowed: false });
  assert.equal(canHold(o), false);
  const held = { ...o, payment_requirements: { requires_instant_payment: false, payment_required_by: "2026-10-16T18:00:00Z", price_guarantee_expires_at: null } };
  assert.equal(canHold(held), true);
  assert.equal(toCard(held, fee).holdable, true);
  assert.equal(toCard(o, fee).holdable, undefined);
  assert.equal((describeCard(toCard(held, fee)) as { hold_available?: boolean }).hold_available, true);
});
