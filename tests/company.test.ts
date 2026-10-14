// Company expenses: amounts read from receipt strings, and CSV that accounting tools (and spreadsheets) take safely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney, toCsv, type ExpenseRow } from "../lib/company";

test("amounts and currencies from receipt strings", () => {
  assert.deepEqual(parseMoney("$412.30 CAD"), { amount: 412.3, currency: "CAD" });
  assert.deepEqual(parseMoney("CA$1,204"), { amount: 1204, currency: "CAD" });
  assert.deepEqual(parseMoney("€89.00"), { amount: 89, currency: "EUR" });
  assert.deepEqual(parseMoney("$123.40", "USD"), { amount: 123.4, currency: "USD" });
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney("free"), null);
});

test("CSV: quoted where needed, and cells that look like formulas are neutralised", () => {
  const row: ExpenseRow = { date: "2026-10-23", person: "Sam Lee", merchant: 'Joe\'s "Diner", Miami', category: "meals", amount: "42.18", currency: "USD", tax: "3.10", trip: "=HYPERLINK(\"x\")", source: "receipt", note: "" };
  const csv = toCsv([row]);
  const [head, line] = csv.trim().split("\r\n");
  assert.equal(head, "Date,Person,Merchant,Category,Amount,Currency,Tax,Trip,Source,Note");
  assert.equal(line, `2026-10-23,Sam Lee,"Joe's ""Diner"", Miami",meals,42.18,USD,3.10,"'=HYPERLINK(""x"")",receipt,`);
});
