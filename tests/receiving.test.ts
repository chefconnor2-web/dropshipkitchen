// Unit tests for case-label parsing (GS1 barcodes) and receiving calendar dates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gs1Date, mergeGs1, parseGs1 } from "../lib/receiving/gs1";
import { daysUntil, parseDay } from "../lib/receiving/dates";

const GS = "\u001d";

test("gs1Date reads YYMMDD and treats day 00 as the month's last day", () => {
  assert.equal(gs1Date("261009"), "2026-10-09");
  assert.equal(gs1Date("260200"), "2026-02-28");
  assert.equal(gs1Date("281300"), undefined);
  assert.equal(gs1Date("260231"), undefined);
});

test("parseGs1 reads the human-readable line on a produce case label", () => {
  const d = parseGs1("(01)10071430010574(13)260929(10)1367016");
  assert.equal(d?.gtin, "10071430010574");
  assert.equal(d?.packDate, "2026-09-29");
  assert.equal(d?.lot, "1367016");
});

test("parseGs1 splits raw scanner output on FNC1 separators", () => {
  const d = parseGs1(`]C1011007143001057415261009${"10"}LOT-77${GS}3202002000`);
  assert.equal(d?.gtin, "10071430010574");
  assert.equal(d?.bestBefore, "2026-10-09");
  assert.equal(d?.lot, "LOT-77");
  assert.equal(d?.netWeight, "20 lb");
});

test("parseGs1 ignores plain item barcodes", () => {
  assert.equal(parseGs1("5164782484"), null);
  assert.equal(parseGs1("hello"), null);
});

test("mergeGs1 combines every barcode on one label, first value winning", () => {
  const d = mergeGs1(["(01)10071430010574(10)A1", "(10)B2(17)261015", "516478"]);
  assert.equal(d?.gtin, "10071430010574");
  assert.equal(d?.lot, "A1");
  assert.equal(d?.expiry, "2026-10-15");
  assert.equal(mergeGs1(["516478"]), null);
});

test("parseDay accepts only real YYYY-MM-DD days", () => {
  assert.equal(parseDay("2026-10-09")?.toISOString(), "2026-10-09T00:00:00.000Z");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("10/09/2026"), null);
  assert.equal(parseDay(null), null);
});

test("daysUntil counts calendar days from today", () => {
  const now = new Date(2026, 9, 3, 18, 30);
  assert.equal(daysUntil(parseDay("2026-10-03")!, now), 0);
  assert.equal(daysUntil(parseDay("2026-10-06")!, now), 3);
  assert.equal(daysUntil(parseDay("2026-10-01")!, now), -2);
});
