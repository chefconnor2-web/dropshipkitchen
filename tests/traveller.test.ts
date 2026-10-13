// Booking forms fill in from the account (splitting the account name) and from saved traveller details.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanProfile, splitName, testTravellerDetails } from "../lib/traveller";

test("splitName keeps middle names with the first name", () => {
  assert.deepEqual(splitName("Ana María Lee"), { firstName: "Ana María", lastName: "Lee" });
  assert.deepEqual(splitName("  Connor   Macaulay "), { firstName: "Connor", lastName: "Macaulay" });
  assert.deepEqual(splitName("Cher"), { firstName: "Cher", lastName: "" });
  assert.deepEqual(splitName(null), { firstName: "", lastName: "" });
});

test("keeps well-formed fields, normalises codes, drops bad values and unknown keys", () => {
  const c = cleanProfile({
    title: "MR",
    gender: "m",
    givenName: "  Connor   James ",
    familyName: "Macaulay",
    bornOn: "1990-04-12",
    email: "chef@example.com",
    phone: "+1 416 555 0101",
    passportNumber: "AB123456",
    passportCountry: "ca",
    passportExpiry: "2031-01-01",
    cardNumber: "4242424242424242",
  });
  assert.deepEqual(c, {
    title: "mr",
    gender: "m",
    givenName: "Connor James",
    familyName: "Macaulay",
    bornOn: "1990-04-12",
    email: "chef@example.com",
    phone: "+1 416 555 0101",
    passportNumber: "AB123456",
    passportCountry: "CA",
    passportExpiry: "2031-01-01",
  });
  assert.deepEqual(cleanProfile({ bornOn: "12/04/1990", email: "nope", passportNumber: "12 34", title: "sir" }), {});
  assert.deepEqual(cleanProfile({ phone: "" }), { phone: "" });
});

test("the test-mode details pass every field's checks, with the tester's email", () => {
  const t = testTravellerDetails("chefconnor2@gmail.com");
  assert.deepEqual(cleanProfile({ ...t }), t);
  assert.equal(t.email, "chefconnor2@gmail.com");
  assert.equal(Object.keys(t).length, 15);
});
