// Fraud and dispute protection: who gets held or refused before we pay a supplier, and the evidence Stripe receives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameMatches, riskDecision, type PaymentFacts } from "../lib/risk";
import { buildEvidence, tripCancellable } from "../lib/disputes";

const card = (p: Partial<PaymentFacts> = {}): PaymentFacts => ({ threeDs: false, riskLevel: "normal", cardholder: null, fingerprint: "fp", card: true, ...p });

test("names match on any shared word, ignoring accents and case", () => {
  assert.ok(nameMatches("JOSÉ GARCÍA LOPEZ", ["Maria Garcia"]));
  assert.ok(nameMatches(null, ["Anyone"]));
  assert.ok(!nameMatches("John Smith", ["Mia Test", "Bo Lee"]));
});

test("risk: refuse past disputers, hold likely stolen cards, book everything else", () => {
  assert.equal(riskDecision(card(), ["Mia Test"], true).action, "refuse");
  assert.equal(riskDecision(card({ riskLevel: "highest", threeDs: true }), ["Mia Test"], false).action, "hold");
  assert.equal(riskDecision(card({ threeDs: true, cardholder: "John Smith" }), ["Mia Test"], false).action, "book"); // the bank carries fraud
  assert.equal(riskDecision(card({ cardholder: "John Smith" }), ["Mia Test"], false).action, "hold"); // no 3DS, not a traveller
  assert.equal(riskDecision(card({ cardholder: "Mia Test" }), ["Mia Test"], false).action, "book");
  assert.equal(riskDecision(card({ riskLevel: "elevated" }), ["Mia Test"], false).action, "hold");
  assert.equal(riskDecision(card({ card: false, cardholder: "Someone Else" }), ["Mia Test"], false).action, "book"); // pay later: provider's risk
});

const flight = {
  id: "f1", number: "CHIT-FL-1", status: "BOOKED", duffelOrderId: "ord_1", bookingReference: "ABC123", email: "mia@test.dev", customerId: "c1",
  cardJson: JSON.stringify({ airline: "Duffel Airways", slices: [{ from: "YWG", to: "YYZ", depart: "2030-11-20T14:42:00" }], refundRule: { kind: "no" }, changeRule: { kind: "no" } }),
  passengersJson: JSON.stringify([{ given_name: "Mia", family_name: "Test" }]), priceCents: 9900, currency: "USD", paidAt: new Date("2030-10-01T10:00:00Z"), bookedAt: new Date("2030-10-01T10:01:00Z"),
  cancelledAt: null, refundCents: null, createdAt: new Date("2030-10-01T09:58:00Z"),
} as never;

test("flight evidence names the ticket, travellers, the terms shown above Pay, 3-D Secure and the activity", () => {
  const e = buildEvidence({ flight, threeDs: true, activity: ["2030-10-01 09:57 UTC search_flights", "2030-10-01 09:58 UTC book_flight"] });
  assert.match(String(e.product_description), /Duffel Airways: YWG → YYZ.*Passengers: Mia Test.*PNR\) ABC123/);
  assert.equal(e.customer_email_address, "mia@test.dev");
  assert.equal(e.service_date, "2030-11-20");
  assert.match(String(e.refund_policy_disclosure), /directly above the Pay button.*No refund · No changes/);
  assert.match(String(e.refund_refusal_explanation), /No cancellation or refund was requested/);
  assert.match(String(e.access_activity_log), /book_flight/);
  assert.match(String(e.uncategorized_text), /3-D Secure/);
});

test("a trip can be cancelled for a dispute only before it happens", () => {
  assert.ok(tripCancellable({ flight }, new Date("2030-11-01T00:00:00Z")));
  assert.ok(!tripCancellable({ flight }, new Date("2030-11-20T13:00:00Z"))); // under 3 hours to departure
  assert.ok(!tripCancellable({}, new Date()));
});
