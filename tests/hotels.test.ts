// Hotels: LiteAPI rates → hotel cards with our fee, the picks Neon shows, the model's search, and the
// prebook/book calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pickHotels, stayWithFee, toCards } from "../lib/hotels";
import { parseHotelSearch } from "../lib/connectors/liteapi";
import { bookRate, LiteapiError, prebook } from "../lib/liteapi";
import { uberLink } from "../lib/flights-shared";

const q = { cityName: "Tokyo", countryCode: "JP", checkin: "2030-05-01", checkout: "2030-05-04", adults: 2, childAges: [], currency: "USD", guestNationality: "US" };
const room = (offerId: string, amount: number, tag = "RFN") => ({ offerId, offerRetailRate: { amount, currency: "USD" }, rates: [{ name: "Double Room", boardName: "Breakfast", cancellationPolicies: { refundableTag: tag } }] });

test("stayWithFee adds $5 + 3% and rounds up to a whole dollar", () => {
  assert.equal(stayWithFee(300), 31_400); // 300 × 1.03 + 5 = 314
  assert.equal(stayWithFee(99.99, { fixedCents: 0, pct: 0 }), 10_000);
});

test("toCards keeps each hotel's cheapest room, cheapest hotel first, with names and refundability", () => {
  const cards = toCards(
    q,
    [
      { hotelId: "h1", roomTypes: [room("o1a", 500), room("o1b", 420, "NRFN")] },
      { hotelId: "h2", roomTypes: [room("o2", 300)] },
      { hotelId: "h3", roomTypes: [] },
    ],
    [
      { id: "h1", name: "Park Hyatt", stars: 5, rating: 9.1, address: "3-7-1 Nishishinjuku", main_photo: "https://img/1.jpg" },
      { id: "h2", name: "Shinjuku Inn", stars: 3 },
    ],
  );
  assert.deepEqual(cards.map((c) => c.id), ["o2", "o1b"]);
  assert.equal(cards[1].name, "Park Hyatt");
  assert.equal(cards[1].refundable, false);
  assert.equal(cards[0].refundable, true);
  assert.equal(cards[0].nights, 3);
  assert.equal(cards[0].priceCents, stayWithFee(300));
});

test("pickHotels mixes cheapest and best rated, and applies budget and stars", () => {
  const cards = toCards(
    q,
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ hotelId: `h${i}`, roomTypes: [room(`o${i}`, 100 * i)] })),
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: `h${i}`, name: `H${i}`, stars: i > 5 ? 5 : 3, rating: i === 8 ? 9.5 : 7 })),
  );
  const picks = pickHotels(cards);
  assert.equal(picks.length, 6);
  assert.equal(picks[0].id, "o1");
  assert.ok(picks.some((p) => p.id === "o8"), "best rated is included");
  assert.deepEqual(pickHotels(cards, 6, 50_00).map((p) => p.id), ["o1"]); // ≤ $50/night over 3 nights
  assert.ok(pickHotels(cards, 6, undefined, 5).every((p) => (p.stars ?? 0) >= 5));
});

test("parseHotelSearch checks city, country and dates", () => {
  const ok = parseHotelSearch({ city: "Tokyo", country_code: "jp", checkin: "2030-05-01", checkout: "2030-05-04", adults: 2, child_ages: [4], max_price_per_night: 0, min_stars: 0 }, "2030-01-01");
  assert.ok(typeof ok !== "string");
  assert.equal(ok.countryCode, "JP");
  assert.deepEqual(ok.childAges, [4]);
  assert.match(String(parseHotelSearch({ city: "Tokyo", country_code: "Japan", checkin: "2030-05-01", checkout: "2030-05-04" }, "2030-01-01")), /country code/);
  assert.match(String(parseHotelSearch({ city: "Tokyo", country_code: "JP", checkin: "2030-05-04", checkout: "2030-05-04" }, "2030-01-01")), /after check-in/);
  assert.match(String(parseHotelSearch({ city: "Tokyo", country_code: "JP", checkin: "2029-05-01", checkout: "2029-05-04" }, "2030-01-01")), /past/);
});

test("uberLink fills the destination", () => {
  const u = new URL(uberLink({ name: "Park Hyatt", address: "3-7-1 Nishishinjuku, Tokyo", latitude: 35.68, longitude: 139.69 }));
  assert.equal(u.searchParams.get("action"), "setPickup");
  assert.equal(u.searchParams.get("pickup"), "my_location");
  assert.equal(u.searchParams.get("dropoff[formatted_address]"), "3-7-1 Nishishinjuku, Tokyo");
  assert.equal(u.searchParams.get("dropoff[latitude]"), "35.68");
});

const seen: Array<{ path: string; key: string; body: Record<string, unknown> }> = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push({ path: req.url ?? "", key: String(req.headers["x-api-key"]), body });
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/rates/prebook")) {
      if (body.offerId === "gone") return res.writeHead(400).end(JSON.stringify({ error: { message: "offer expired" } }));
      return res.end(JSON.stringify({ data: { prebookId: "pb_1", price: 301.5, currency: "USD" } }));
    }
    res.end(JSON.stringify({ data: { bookingId: "bk_1", status: "CONFIRMED", hotelConfirmationCode: "HC123", price: 301.5, currency: "USD" } }));
  });
});
const ready = new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
after(() => server.close());

test("prebook and book send the key and the guest, and errors keep LiteAPI's message", async () => {
  await ready;
  process.env.LITEAPI_KEY = "sand_test";
  process.env.LITEAPI_BOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const held = await prebook("o1");
  assert.deepEqual(held, { prebookId: "pb_1", price: 301.5, currency: "USD" });
  assert.equal(seen[0].key, "sand_test");
  assert.equal(seen[0].body.usePaymentSdk, false);
  const b = await bookRate("pb_1", { firstName: "Ana", lastName: "Lee", email: "ana@example.com" }, "C1-HT-1");
  assert.equal(b.hotelConfirmationCode, "HC123");
  assert.deepEqual((seen[1].body.payment as Record<string, unknown>).method, "ACC_CREDIT_CARD");
  assert.equal((seen[1].body.guests as Array<Record<string, unknown>>)[0].firstName, "Ana");
  await assert.rejects(prebook("gone"), (e: unknown) => e instanceof LiteapiError && e.status === 400 && /offer expired/.test(e.message));
  delete process.env.LITEAPI_KEY;
  delete process.env.LITEAPI_BOOK_URL;
});
