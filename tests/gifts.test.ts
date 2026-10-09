// Gifts: reading the recipient list the merchant types, and checking a claim's shipping address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaim, parseRecipients } from "../lib/gifts";

test("parseRecipients reads email-and-name lines in the usual shapes, dropping repeats", () => {
  const r = parseRecipients("sam@example.com, Sam Lee\nAlex Kim <ALEX@example.com>\n\njo@example.com\nSam@Example.com, again\nnot an email");
  assert.deepEqual(r.recipients, [
    { email: "sam@example.com", name: "Sam Lee" },
    { email: "alex@example.com", name: "Alex Kim" },
    { email: "jo@example.com", name: null },
  ]);
  assert.deepEqual(r.bad, ["not an email"]);
  assert.deepEqual(parseRecipients("Lee, Pat; pat@example.com").recipients, [{ email: "pat@example.com", name: "Lee Pat" }]);
});

const good = { name: "Sam Lee", phone: "(204) 555-0199", line1: "12 Main St", line2: "", city: "Winnipeg", state: "MB", postal: "r3c 0a1", country: "ca" };

test("checkClaim cleans a good address", () => {
  const r = checkClaim(good);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.address.country, "CA");
    assert.equal(r.address.postal, "R3C 0A1");
    assert.equal(r.address.phone, "+12045550199");
  }
});

test("checkClaim explains what's missing", () => {
  const err = (f: Partial<typeof good>) => {
    const r = checkClaim({ ...good, ...f });
    return r.ok ? "" : r.error;
  };
  assert.match(err({ name: "S" }), /full name/);
  assert.match(err({ country: "ZZ" }), /country we ship to/);
  assert.match(err({ line1: "" }), /street address/);
  assert.match(err({ state: "" }), /province or state/);
  assert.match(err({ postal: "" }), /postal code/);
  assert.match(err({ phone: "12" }), /phone number/);
});
