// Accounts: sign-in codes, safe redirects and who may see which chats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newCode, normalizeEmail, safeNext } from "../lib/session";
import { ownedBy } from "../lib/chat-session";

test("codes are 6 digits, zero-padded and random", () => {
  const codes = new Set(Array.from({ length: 2000 }, newCode));
  for (const c of codes) assert.match(c, /^\d{6}$/);
  assert.ok(codes.size > 1990);
});

test("emails are lower-cased and checked", () => {
  assert.equal(normalizeEmail("  Sam@Example.COM "), "sam@example.com");
  for (const bad of ["", "sam", "sam@", "a@b", "a b@c.com", "a@b.com, c@d.com", "<a@b.com>", "x".repeat(250) + "@b.com"]) assert.equal(normalizeEmail(bad), null, bad);
});

test("after sign-in we only ever go to a path on this site", () => {
  assert.equal(safeNext("/boxes/maker-box"), "/boxes/maker-box");
  assert.equal(safeNext("/c/abc?x=1"), "/c/abc?x=1");
  for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "", null, undefined]) assert.equal(safeNext(bad), "/account", String(bad));
});

test("a signed-in shopper sees only their account's chats; signed out, only this browser's unowned ones", () => {
  assert.deepEqual(ownedBy("cust_1", "vid_1"), { customerId: "cust_1" });
  // A chat that belongs to an account never matches by visitor id alone.
  assert.deepEqual(ownedBy(null, "vid_1"), { customerId: null, visitorId: "vid_1" });
  // Nobody: matches nothing.
  assert.deepEqual(ownedBy(null, null), { id: "\u0000never" });
});
