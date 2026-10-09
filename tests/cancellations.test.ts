// Cancelling: when the pages offer it, and what the shopper gets back (never more than the provider refunds us,
// never more than the provider's price, so our fee is kept).
import { test } from "node:test";
import assert from "node:assert/strict";
import { canCancelStay } from "../lib/hotel-booking";
import { canCancelFlight, moneyBack } from "../lib/flight-booking";

test("stays can be cancelled online while booked, refundable and before check-in", () => {
  assert.equal(canCancelStay({ status: "BOOKED" }, { checkin: "2030-05-01", refundable: true }, "2030-04-01"), true);
  assert.equal(canCancelStay({ status: "BOOKED" }, { checkin: "2030-05-01", refundable: null }, "2030-04-01"), true);
  assert.equal(canCancelStay({ status: "BOOKED" }, { checkin: "2030-05-01", refundable: false }, "2030-04-01"), false);
  assert.equal(canCancelStay({ status: "BOOKED" }, { checkin: "2030-05-01", refundable: true }, "2030-05-01"), false);
  assert.equal(canCancelStay({ status: "CANCELLED" }, { checkin: "2030-05-01", refundable: true }, "2030-04-01"), false);
});

test("flights can be cancelled online while booked and more than 3 hours before departure", () => {
  const card = { slices: [{ depart: "2030-05-01T10:00:00" }] } as never;
  assert.equal(canCancelFlight({ status: "BOOKED", duffelOrderId: "ord_1" }, card, new Date("2030-05-01T06:00:00Z")), true);
  assert.equal(canCancelFlight({ status: "BOOKED", duffelOrderId: "ord_1" }, card, new Date("2030-05-01T08:00:00Z")), false);
  assert.equal(canCancelFlight({ status: "BOOKED", duffelOrderId: null }, card, new Date("2030-04-01T00:00:00Z")), false);
});

test("the flight refund passed on is the airline's money refund, capped at Duffel's price, never airline credit", () => {
  const b = { currency: "USD", duffelAmount: "400.00" };
  assert.equal(moneyBack({ refund_to: "balance", refund_amount: "250.50", refund_currency: "USD" }, b), 25_050);
  assert.equal(moneyBack({ refund_to: "original_form_of_payment", refund_amount: "999.00", refund_currency: "USD" }, b), 40_000);
  assert.equal(moneyBack({ refund_to: "airline_credits", refund_amount: "250.00", refund_currency: "USD" }, b), 0);
  assert.equal(moneyBack({ refund_to: "balance", refund_amount: "250.00", refund_currency: "EUR" }, b), 0);
  assert.equal(moneyBack({ refund_to: "balance", refund_amount: null, refund_currency: null }, b), 0);
});
