// Hotels: LiteAPI rates → hotel cards with our fee, the picks Neon shows, the model's search, and the
// prebook/book calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { cardId, freeCancelUntil, keepSearch, keptSearch, liteOfferId, localCurrency, matchHotels, payAtHotel, pickHotels, stayWithFee, toCards } from "../lib/hotels";
import { describeHotel, hotelPage, parseCursor, parseHotelSearch, rankHotels } from "../lib/connectors/liteapi";
import { bookRate, LiteapiError, prebook } from "../lib/liteapi";
import { isoPrice, payAtHotelLabel, uberLink, type HotelCard } from "../lib/flights-shared";

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
  assert.deepEqual(cards.map((c) => c.offerId), ["o2", "o1b"]);
  assert.equal(cards[1].name, "Park Hyatt");
  assert.equal(cards[1].refundable, false);
  assert.equal(cards[0].refundable, true);
  assert.equal(cards[0].nights, 3);
  assert.equal(cards[0].priceCents, stayWithFee(300));
});

test("cards get a short link-safe id for LiteAPI's very long offer ids", () => {
  const long = "GE5ESNBSGI2TCLJQGMYTKLJRGIZTCLJZGI3S2MRVGQ4DQMRXHA2DSMBSGYYC2NJUGI4TMMBYGIZDSNBSGAWTEMBSGYWTCMBNGE3CYMJNGE2CYMRNGEZDMXZQGYYTIMBVGMZDAMBQGEZDAMRTGU3DCMZRHE".repeat(8) + "/+==";
  const [card] = toCards(q, [{ hotelId: "h1", roomTypes: [room(long, 300)] }], [{ id: "h1", name: "Long Offer Hotel" }]);
  assert.match(card.id, /^ht_[A-Za-z0-9_-]{16}$/);
  assert.equal(card.id, cardId(long));
  assert.equal(liteOfferId(card), long);
  assert.equal(liteOfferId({ ...card, offerId: undefined, id: "old-long-id" }), "old-long-id"); // cards saved before the short id
});

test("pickHotels mixes cheapest and best rated, and applies budget and stars", () => {
  const cards = toCards(
    q,
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ hotelId: `h${i}`, roomTypes: [room(`o${i}`, 100 * i)] })),
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: `h${i}`, name: `H${i}`, stars: i > 5 ? 5 : 3, rating: i === 8 ? 9.5 : 7 })),
  );
  const picks = pickHotels(cards);
  assert.equal(picks.length, 6);
  assert.equal(picks[0].offerId, "o1");
  assert.ok(picks.some((p) => p.offerId === "o8"), "best rated is included");
  assert.deepEqual(pickHotels(cards, 6, 50_00).map((p) => p.offerId), ["o1"]); // ≤ $50/night over 3 nights
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

const hotel = (name: string, priceCents: number, extra: Partial<HotelCard> = {}): HotelCard => ({
  kind: "hotel", id: cardId(name), offerId: name, hotelId: name, name, photo: null, stars: 3, rating: 8, address: "", city: "Winnipeg", latitude: null, longitude: null,
  room: "Room", board: "Room only", refundable: true, checkin: "2030-10-15", checkout: "2030-10-17", nights: 2, adults: 1, childAges: [], priceCents, currency: "CAD", ...extra,
});

test("matchHotels finds the named hotel fuzzily (typo, case, generic words, city name) and nothing else", () => {
  const cards = [hotel("Quality Inn & Suites", 237_00), hotel("Lakeview Signature, Trademark Collection by Wyndham", 300_00), hotel("Lakeview Inns & Suites Winnipeg", 180_00), hotel("Canad Inns Destination Centre Fort Garry", 208_00)];
  assert.deepEqual(matchHotels(cards, "Lakeview", "Winnipeg").map((c) => c.name), ["Lakeview Inns & Suites Winnipeg", "Lakeview Signature, Trademark Collection by Wyndham"]);
  assert.deepEqual(matchHotels(cards, "the lakeveiw signature hotel", "Winnipeg").map((c) => c.name), ["Lakeview Signature, Trademark Collection by Wyndham"]);
  assert.deepEqual(matchHotels(cards, "Lakeview Winnipeg", "Winnipeg").length, 2);
  assert.deepEqual(matchHotels(cards, "Fairmont", "Winnipeg"), []);
  assert.deepEqual(matchHotels(cards, "quality inn", "Winnipeg").map((c) => c.name), ["Quality Inn & Suites"]);
});

test("rankHotels puts named hotels first even outside the budget, and pages come from the kept list", () => {
  const all = Array.from({ length: 20 }, (_, i) => hotel(`Hotel ${String.fromCharCode(65 + i)}`, (100 + i * 10) * 100)).concat(hotel("Lakeview Signature", 900_00));
  const { ranked, named } = rankHotels(all, { cityName: "Winnipeg", hotelName: "Lakeview Signature", maxPerNightCents: 200_00 });
  assert.equal(named?.length, 1);
  assert.equal(ranked[0].name, "Lakeview Signature");
  const id = keepSearch(ranked);
  const p1 = hotelPage(ranked, id, 0, 6);
  assert.equal(p1.page.length, 6);
  assert.equal(p1.next, `${id}.6`);
  const c = parseCursor(p1.next!)!;
  const p2 = hotelPage(keptSearch(c.id)!, c.id, c.offset, 6);
  assert.ok(p2.page.every((h) => !p1.page.some((x) => x.id === h.id)));
  const last = hotelPage(ranked, id, 18, 6);
  assert.equal(last.next, undefined);
  assert.equal(keptSearch("nope"), null);
  assert.equal(parseCursor("bad cursor"), null);
  assert.equal(rankHotels(all, { cityName: "Winnipeg", hotelName: "Fairmont" }).named?.length, 0);
});

test("pay-at-hotel taxes are kept apart from the total, and the free-cancellation deadline is read", () => {
  const rates = [
    { retailRate: { total: [{ amount: 200, currency: "CAD" }], taxesAndFees: [{ included: true, description: "VAT", amount: 20, currency: "CAD" }, { included: false, description: "City Tax", amount: 49, currency: "CAD" }] } },
    { retailRate: { taxesAndFees: null } },
  ];
  assert.deepEqual(payAtHotel(rates), [{ amountCents: 49_00, currency: "CAD", description: "city tax" }]);
  assert.equal(payAtHotelLabel({ payAtHotel: payAtHotel(rates) }), "CAD 49");
  assert.equal(payAtHotelLabel({ payAtHotel: [] }), null);
  const rfn = { cancellationPolicies: { refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: "2030-10-14 16:00:00", amount: 120, currency: "CAD", type: "amount", timezone: "GMT" }, { cancelTime: "2030-10-12 16:00:00", amount: 0 }] } };
  assert.equal(freeCancelUntil(rfn), "2030-10-14 16:00 GMT");
  assert.equal(freeCancelUntil({ cancellationPolicies: { refundableTag: "NRFN", cancelPolicyInfos: rfn.cancellationPolicies.cancelPolicyInfos } }), null);
  const [card] = toCards({ ...q, currency: "CAD" }, [{ hotelId: "h1", roomTypes: [{ offerId: "o1", offerRetailRate: { amount: 200, currency: "CAD" }, rates: [{ ...rates[0], ...rfn }] }] }], [{ id: "h1", name: "Quality Inn & Suites" }]);
  assert.equal(card.freeCancelUntil, "2030-10-14 16:00 GMT");
  assert.equal(card.priceCents, stayWithFee(200)); // the CAD 49 is not in the total
  const d = describeHotel(card);
  assert.equal(d.currency, "CAD");
  assert.match(String(d.total), /^CAD \d/);
  assert.equal(d.pay_at_hotel, "CAD 49");
  assert.equal(d.free_cancellation_until, "2030-10-14 16:00 GMT");
});

test("prices carry their ISO currency, and the default currency is the customer's local one", () => {
  assert.equal(isoPrice({ priceCents: 1_240_00, currency: "cad" }), "CAD 1,240");
  assert.equal(isoPrice({ priceCents: 49_50, currency: "USD" }), "USD 49.50");
  assert.equal(localCurrency("CA"), "CAD");
  assert.equal(localCurrency("fr"), "EUR");
  assert.equal(localCurrency(undefined), "USD");
  const s = parseHotelSearch({ city: "Winnipeg", country_code: "CA", checkin: "2030-10-15", checkout: "2030-10-17", currency: "cad", hotel_name: " Lakeview ", max_results: 99 }, "2030-01-01");
  assert.ok(typeof s !== "string");
  assert.equal(s.currency, "CAD");
  assert.equal(s.hotelName, "Lakeview");
  assert.equal(s.maxResults, 30);
  const d = parseHotelSearch({ city: "Winnipeg", country_code: "CA", checkin: "2030-10-15", checkout: "2030-10-17" }, "2030-01-01");
  assert.ok(typeof d !== "string" && d.maxResults === 6 && d.currency === "USD");
});
