// Flight booking: passenger form checks, phone numbers, infants on laps, and the Duffel passenger payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, orderPassengers, parsePassengers, passengerSlots, routeLabel } from "../lib/flight-booking";

const today = "2026-10-07";
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const adult = { title_0: "ms", gender_0: "f", given_0: "Jo Anne", family_0: "O'Neil-Smith", born_0: "1990-04-02" };

test("passenger slots from the offer", () => {
  const slots = passengerSlots({ passengers: [{ id: "a", type: "adult" }, { id: "c", age: 7 }, { id: "i", type: "infant_without_seat" }] });
  assert.deepEqual(slots.map((s) => s.kind), ["adult", "child", "infant"]);
});

test("a valid adult passes, names kept as typed (spaces tidied)", () => {
  const r = parsePassengers(form({ ...adult, given_0: "Jo   Anne" }), [{ id: "pas_1", kind: "adult", age: null }], false, today);
  assert.ok(Array.isArray(r));
  if (Array.isArray(r)) assert.deepEqual(r[0], { id: "pas_1", title: "ms", gender: "f", given_name: "Jo Anne", family_name: "O'Neil-Smith", born_on: "1990-04-02" });
});

test("bad passenger details are explained", () => {
  const slot = [{ id: "p", kind: "adult" as const, age: null }];
  assert.match(String(parsePassengers(form({ ...adult, title_0: "" }), slot, false, today)), /title/);
  assert.match(String(parsePassengers(form({ ...adult, given_0: "Zoë" }), slot, false, today)), /English letters/);
  assert.match(String(parsePassengers(form({ ...adult, born_0: "2030-01-01" }), slot, false, today)), /date of birth/);
  assert.match(String(parsePassengers(form({ ...adult, born_0: "2020-01-01" }), slot, false, today)), /12 or older/);
  assert.match(String(parsePassengers(form(adult), slot, true, today)), /passport number/);
  const withPassport = parsePassengers(form({ ...adult, passport_0: "ab 123456", passport_country_0: "ca", passport_expiry_0: "2030-01-01" }), slot, true, today);
  assert.ok(Array.isArray(withPassport));
  if (Array.isArray(withPassport)) assert.deepEqual(withPassport[0].passport, { number: "AB123456", country: "CA", expires: "2030-01-01" });
  assert.match(String(parsePassengers(form({ ...adult, passport_0: "AB123456", passport_country_0: "CA", passport_expiry_0: "2026-01-01" }), slot, true, today)), /expired/);
});

test("phone numbers", () => {
  assert.equal(normalizePhone("(416) 555-0123"), "+14165550123");
  assert.equal(normalizePhone("1 416 555 0123"), "+14165550123");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("555"), null);
});

test("infants ride on an adult's lap, contact details on everyone", () => {
  const slots = passengerSlots({ passengers: [{ id: "a1", type: "adult" }, { id: "i1", type: "infant_without_seat" }] });
  const pax = [
    { id: "a1", title: "mr" as const, gender: "m" as const, given_name: "Sam", family_name: "Lee", born_on: "1985-01-01" },
    { id: "i1", title: "miss" as const, gender: "f" as const, given_name: "Mia", family_name: "Lee", born_on: "2026-01-01", passport: { number: "X1234567", country: "CA", expires: "2031-01-01" } },
  ];
  const out = orderPassengers(pax, slots, "sam@example.com", "+14165550123");
  assert.equal(out[0].infant_passenger_id, "i1");
  assert.equal(out[1].infant_passenger_id, undefined);
  assert.equal(out[1].email, "sam@example.com");
  assert.deepEqual(out[1].identity_documents, [{ type: "passport", unique_identifier: "X1234567", issuing_country_code: "CA", expires_on: "2031-01-01" }]);
});

test("route labels", () => {
  const s = (from: string, to: string) => ({ from, to, fromCity: from, toCity: to, depart: "2026-11-03T10:00:00", arrive: "2026-11-03T20:00:00", durationMin: 600, stops: 0, via: [], segments: [] });
  const base = { kind: "flight" as const, id: "off_1", airline: "X", logo: null, priceCents: 1, currency: "USD", cabin: "Economy", fareBrand: null, checkedBags: 0, carryOn: 0, refundable: null, changeable: null, expiresAt: "" };
  assert.equal(routeLabel({ ...base, slices: [s("YVR", "HND")] }), "YVR → HND");
  assert.equal(routeLabel({ ...base, slices: [s("YVR", "HND"), s("HND", "YVR")] }), "YVR → HND (return)");
});
