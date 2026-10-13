// Trips: a chat's paid bookings, Amazon cart and emails gathered into an itinerary and its receipts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrip, chatShown } from "../lib/trips";

const flightCard = {
  kind: "flight",
  id: "off_1",
  airline: "Air Canada",
  cabin: "economy",
  priceCents: 41230,
  currency: "CAD",
  slices: [{ from: "YYZ", fromCity: "Toronto", to: "MIA", toCity: "Miami", depart: "2026-10-23T08:05:00", arrive: "2026-10-23T11:20:00", segments: [{ carrier: "AC", flight: "1630" }] }],
};
const hotelCard = { kind: "hotel", id: "h_1", offerId: "lite_1", name: "Beach Inn", address: "1 Ocean Dr", city: "Miami", room: "King room", checkin: "2026-10-23", checkout: "2026-10-26", nights: 3 };
const ui = JSON.stringify([
  { role: "bot", items: [flightCard, { ...hotelCard }] },
  { role: "bot", items: [{ kind: "cart-link", id: "cl_x", url: "https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B0ABCDEFGH&Quantity.1=1", site: "amazon.com", products: 1, units: 1, items: [{ asin: "B0ABCDEFGH", quantity: 1, title: "Phone charger", delivery: "Wednesday, October 22" }] }] },
  { role: "bot", at: "2026-10-13T19:00:00Z", items: [{ kind: "email-draft", id: "em_1", to: "desk@beachinn.com", cc: [], subject: "Please hold a package", body: "…", from: null, status: "draft" }] },
  { role: "bot", at: "2026-10-13T19:01:00Z", items: [{ kind: "email-draft", id: "em_1", to: "desk@beachinn.com", cc: [], subject: "Please hold a package", body: "…", from: null, status: "sent" }] },
]);
const base = { priceCents: 41230, currency: "CAD", refundCents: null, paidAt: new Date("2026-10-13T18:00:00Z"), createdAt: new Date("2026-10-13T17:59:00Z") };
const flight = { ...base, id: "fb1", number: "FL-1", status: "BOOKED", offerId: "off_1", cardJson: JSON.stringify(flightCard), passengersJson: JSON.stringify([{ given_name: "Connor", family_name: "M" }]), bookingReference: "ABC123", href: "/flights/trip/FL-1?t=x" };
const hotel = { ...base, priceCents: 60000, id: "hb1", number: "HT-1", status: "BOOKED", offerId: "lite_1", cardJson: JSON.stringify(hotelCard), firstName: "Connor", lastName: "M", confirmationCode: "HX9", href: "/hotels/stay/HT-1?t=y" };

test("reads a chat's card ids, latest cart link and the latest version of each email", () => {
  const s = chatShown(ui);
  assert.deepEqual([...s.flights], ["off_1"]);
  assert.deepEqual([...s.hotels].sort(), ["h_1", "lite_1"]);
  assert.equal(s.cart?.items?.[0].delivery, "Wednesday, October 22");
  assert.equal(s.emails.length, 1);
  assert.equal(s.emails[0].card.status, "sent");
  assert.deepEqual(chatShown("not json").emails, []);
});

test("builds the itinerary in time order and a receipt for each booking, the cart and the email", () => {
  const t = buildTrip({ id: "c1", title: "Miami trip", uiJson: ui }, [flight], [hotel], "2026-10-13")!;
  assert.equal(t.start, "2026-10-23");
  assert.equal(t.end, "2026-10-26");
  assert.equal(t.phase, "upcoming");
  assert.match(t.title, /^Miami · /);
  assert.deepEqual(t.itinerary.map((i) => i.kind), ["flight", "checkin", "checkout", "package", "email"]);
  assert.match(t.itinerary[0].detail, /AC 1630 · departs 08:05, arrives 11:20/);
  assert.deepEqual(t.receipts.map((r) => r.kind), ["flight", "hotel", "amazon", "email"]);
  assert.equal(t.receipts[0].confirmation, "ABC123");
  assert.equal(t.receipts[0].amount, "$412.30 CAD");
  assert.equal(t.receipts[1].confirmation, "HX9");
  assert.equal(t.receipts[2].href, "https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B0ABCDEFGH&Quantity.1=1");
  assert.equal(t.receipts[3].status, "Sent");
});

test("no paid booking, no trip; cancelled bookings keep their receipt but leave the itinerary; phases by date", () => {
  assert.equal(buildTrip({ id: "c1", title: "x", uiJson: ui }, [], [], "2026-10-13"), null);
  const t = buildTrip({ id: "c1", title: "x", uiJson: "[]" }, [{ ...flight, status: "CANCELLED", refundCents: 30000 }], [], "2026-10-13")!;
  assert.equal(t.cancelled, true);
  assert.equal(t.itinerary.length, 0);
  assert.equal(t.receipts[0].status, "Cancelled");
  assert.equal(t.receipts[0].refunded, "$300.00 CAD");
  assert.equal(buildTrip({ id: "c1", title: "x", uiJson: ui }, [flight], [hotel], "2026-10-24")!.phase, "now");
  assert.equal(buildTrip({ id: "c1", title: "x", uiJson: ui }, [flight], [hotel], "2026-11-01")!.phase, "past");
});
