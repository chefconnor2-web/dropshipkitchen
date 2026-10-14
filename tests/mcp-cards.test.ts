// The Chit MCP's in-chat cards: Neon's cards become view cards with absolute Book links filed under the trip chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewCards } from "../lib/mcp-cards";
import type { FlightCard, HotelCard } from "../lib/flights-shared";

const slice = { from: "YVR", fromCity: "Vancouver", to: "MIA", toCity: "Miami", depart: "2026-11-03T07:05:00", arrive: "2026-11-03T17:40:00", durationMin: 455, stops: 1, via: ["YYZ"], segments: [] };
const flight: FlightCard = {
  kind: "flight", id: "off_std", airline: "Air Canada", logo: null, priceCents: 61200, currency: "CAD", cabin: "economy", fareBrand: "Standard", checkedBags: 1, carryOn: 1,
  refundable: false, changeable: true, slices: [slice, { ...slice, from: "MIA", fromCity: "Miami", to: "YVR", toCity: "Vancouver" }], expiresAt: "2026-11-01T00:00:00Z",
  changeRule: { kind: "fee", fee: "$75" }, refundRule: { kind: "no" },
  fares: [
    { id: "off_basic", brand: "Basic", priceCents: 53400, checkedBags: 0, carryOn: 1, changeRule: { kind: "no" }, refundRule: { kind: "no" } },
    { id: "off_std", brand: "Standard", priceCents: 61200, checkedBags: 1, carryOn: 1, changeRule: { kind: "fee", fee: "$75" }, refundRule: { kind: "no" } },
  ],
};

test("flight card: round trip title, fare options with their own links, chat on every link", () => {
  const [c] = viewCards([flight], "chat1");
  assert.equal(c.title, "Vancouver → Miami and back");
  assert.equal(c.lines.length, 2);
  assert.match(c.actions[0].url, /\/flights\/book\/off_std\?chat=chat1$/);
  assert.deepEqual(c.options?.map((o) => o.label), ["Basic", "Standard"]);
  assert.match(c.options![0].url, /\/flights\/book\/off_basic\?chat=chat1$/);
  assert.ok(c.badges?.includes("Changes $75"));
});

test("hotel card: book and ride links; browser cards need a chat", () => {
  const hotel: HotelCard = { kind: "hotel", id: "h_1", hotelId: "lp1", name: "The Gabriel", photo: null, stars: 4, rating: 8.7, address: "1100 Biscayne Blvd", city: "Miami", latitude: 25.78, longitude: -80.19, room: "King", board: "Room only", refundable: true, checkin: "2026-11-03", checkout: "2026-11-10", nights: 7, adults: 1, childAges: [], priceCents: 128400, currency: "USD" };
  const [h] = viewCards([hotel], "chat1");
  assert.match(h.actions[0].url, /\/hotels\/book\/h_1\?chat=chat1$/);
  assert.equal(h.actions[1].label, "Ride there");
  assert.deepEqual(viewCards([{ kind: "browser", id: "br_1", session: "s", site: "discovercars.com" }]), []);
});
