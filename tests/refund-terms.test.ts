// The refund terms shown before Pay, at checkout and in emails say what the code does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutNote, emailTerms, fareRulesLine, flightTerms, hotelTerms } from "../lib/refund-terms";

test("flight terms: rules, what a cancel returns, and the automatic refund when we can't book", () => {
  const refundable = flightTerms({ refundRule: { kind: "fee", fee: "USD 10" }, changeRule: { kind: "free" } });
  assert.match(refundable, /^Refund minus USD 10 · Free changes\./);
  assert.match(refundable, /what the airline refunds, shown before you confirm; our service fee isn't refunded/);
  assert.match(refundable, /everything back automatically/);
  assert.match(flightTerms({ refundRule: { kind: "no" }, changeRule: { kind: "no" } }), /No refund · No changes\. If you cancel, nothing is refunded\./);
  // Unknown rules are read as non-refundable, and said so.
  assert.match(fareRulesLine({}), /not stated by the airline: treat it as non-refundable/);
  assert.match(flightTerms({}), /nothing is refunded/);
});

test("hotel terms: the free-cancellation deadline, non-refundable rooms, and the fee", () => {
  assert.match(hotelTerms({ refundable: true, freeCancelUntil: "2026-11-05 01:59 GMT" }), /^Free cancellation until 2026-11-05 01:59 GMT: cancel online for a refund of the room price; our service fee isn't refunded\. After that, no refund\./);
  assert.match(hotelTerms({ refundable: false }), /^Non-refundable: nothing is refunded if you cancel\./);
  assert.match(hotelTerms({ refundable: true }), /deadline is in your confirmation/);
});

test("checkout note and email footer link the policy and fit Stripe's limit", () => {
  assert.match(checkoutNote("x"), /Full refund policy: .*\/refunds$/);
  assert.ok(checkoutNote("y".repeat(2000)).length <= 1200);
  const e = emailTerms("Refundable.", "https://chit.test/trip/1");
  assert.match(e, /Cancel from your booking page: https:\/\/chit\.test\/trip\/1/);
  assert.match(e, /before disputing a charge/);
});
