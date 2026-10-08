// Trips with friends: the shared flights are found again by flight number and time (prices expire), with
// the closest flights that day as the fallback, and nothing private in the link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cabinOf, departed, destinationLabel, flightKey, matchTrip, tripDates, tripSearch, tripTitle } from "../lib/shared-trips";
import type { FlightCard } from "../lib/flights-shared";

const slice = (from: string, to: string, flight: string, depart: string, arrive: string) => ({
  from,
  fromCity: from === "YWG" ? "Winnipeg" : "Toronto",
  to,
  toCity: to === "YYZ" ? "Toronto" : "Winnipeg",
  depart,
  arrive,
  durationMin: 150,
  stops: 0,
  via: [],
  segments: [{ from, to, depart, arrive, carrier: "Air Canada", flight }],
});
const card = (id: string, price: number, out: [string, string], back?: [string, string], airline = "Air Canada"): FlightCard => ({
  kind: "flight",
  id,
  airline,
  logo: null,
  priceCents: price,
  currency: "CAD",
  cabin: "Economy",
  fareBrand: null,
  checkedBags: 0,
  carryOn: 1,
  refundable: false,
  changeable: true,
  slices: [slice("YWG", "YYZ", out[0], out[1], out[1].replace("T08", "T11")), ...(back ? [slice("YYZ", "YWG", back[0], back[1], back[1].replace("T18", "T19"))] : [])],
  expiresAt: "2026-11-01T00:00:00Z",
});

const shared = card("", 0, ["AC260", "2026-11-03T08:05:00"], ["AC265", "2026-11-10T18:30:00"]);

test("flightKey is the flights, not the price or offer", () => {
  const today = card("off_new", 45200, ["AC260", "2026-11-03T08:05:00"], ["AC265", "2026-11-10T18:30:00"]);
  assert.equal(flightKey(today), flightKey(shared));
  assert.equal(flightKey(shared), "AC260@2026-11-03T08:05|AC265@2026-11-10T18:30");
  assert.notEqual(flightKey(card("x", 1, ["AC262", "2026-11-03T08:05:00"], ["AC265", "2026-11-10T18:30:00"])), flightKey(shared));
});

test("matchTrip finds the same flights at today's cheapest price", () => {
  const offers = [
    card("off_a", 61000, ["AC260", "2026-11-03T08:05:00"], ["AC265", "2026-11-10T18:30:00"]),
    card("off_b", 52000, ["AC260", "2026-11-03T08:05:00"], ["AC265", "2026-11-10T18:30:00"]),
    card("off_c", 30000, ["WS501", "2026-11-03T07:00:00"], ["WS502", "2026-11-10T18:00:00"], "WestJet"),
  ];
  const m = matchTrip(shared, offers);
  assert.deepEqual(m.exact.map((c) => c.id), ["off_b", "off_a"]);
  assert.equal(m.similar.length, 0);
});

test("when the flights are gone, the closest ones that day come first, plus the day's best value", () => {
  const offers = [
    card("off_far", 40000, ["AC270", "2026-11-03T20:00:00"], ["AC265", "2026-11-10T18:30:00"]),
    card("off_near", 48000, ["AC262", "2026-11-03T09:00:00"], ["AC265", "2026-11-10T18:30:00"]),
    card("off_ws", 20000, ["WS501", "2026-11-03T08:00:00"], ["WS502", "2026-11-10T18:00:00"], "WestJet"),
  ];
  const m = matchTrip(shared, offers);
  assert.equal(m.exact.length, 0);
  assert.equal(m.similar[0].id, "off_near");
  assert.ok(m.similar.some((c) => c.id === "off_ws"), "the cheapest flight that day is offered too");
  assert.ok(m.similar.length <= 3);
  assert.deepEqual(matchTrip(shared, []), { exact: [], similar: [] });
});

test("tripSearch asks for the same route, dates and cabin for the joining group", () => {
  const s = tripSearch(shared, "business", 2, [6]);
  assert.deepEqual(s.slices, [
    { origin: "YWG", destination: "YYZ", date: "2026-11-03" },
    { origin: "YYZ", destination: "YWG", date: "2026-11-10" },
  ]);
  assert.equal(s.adults, 2);
  assert.deepEqual(s.childAges, [6]);
  assert.equal(s.cabin, "business");
  assert.equal(tripSearch(shared, "economy", 40, []).adults, 9);
});

test("labels and cabins", () => {
  assert.equal(cabinOf({ cabin: "Premium Economy" }), "premium_economy");
  assert.equal(cabinOf({ cabin: "Business Saver" }), "business");
  assert.equal(cabinOf({ cabin: "Economy Basic" }), "economy");
  assert.equal(destinationLabel(shared), "Toronto");
  assert.equal(tripTitle(shared, "Connor"), "Join Connor's trip to Toronto");
  assert.equal(tripTitle(shared, null), "Fly together to Toronto");
  assert.equal(tripDates(shared), "Nov 3 – Nov 10");
});

test("a trip counts as departed only once its first flight's day is past", () => {
  assert.equal(departed(shared, new Date("2026-11-02T12:00:00Z")), false);
  assert.equal(departed(shared, new Date("2026-11-03T23:00:00Z")), false);
  assert.equal(departed(shared, new Date("2026-11-05T12:00:00Z")), true);
});
