// Booking forms fill in from the account: splitting the account name into first and last.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitName } from "../lib/traveller";

test("splitName keeps middle names with the first name", () => {
  assert.deepEqual(splitName("Ana María Lee"), { firstName: "Ana María", lastName: "Lee" });
  assert.deepEqual(splitName("  Connor   Macaulay "), { firstName: "Connor", lastName: "Macaulay" });
  assert.deepEqual(splitName("Cher"), { firstName: "Cher", lastName: "" });
  assert.deepEqual(splitName(null), { firstName: "", lastName: "" });
});
