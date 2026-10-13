// Gmail connection: the raw message Gmail sends, the id-token address, token encryption, and address checks.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.GMAIL_TOKEN_KEY = "test-key-for-gmail-tokens";
import { buildMessage, emailFromIdToken, openToken, sealToken } from "../lib/gmail";
import { validEmail } from "../lib/connectors/trips";

test("raw message: headers, UTF-8 subject, base64 body, no header injection", () => {
  const raw = buildMessage({ from: "me@gmail.com", to: ["desk@hotel.com\r\nBcc: evil@x.com"], subject: "Hold my package ✈️", text: "Hi,\nPlease hold it.\nThanks" });
  const [head, body] = raw.split("\r\n\r\n");
  assert.match(head, /^From: me@gmail\.com$/m);
  assert.match(head, /^To: desk@hotel\.com Bcc: evil@x\.com$/m, "a newline in a header can't start a new header");
  assert.ok(!/^Bcc:/m.test(head));
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Hi,\r\nPlease hold it.\r\nThanks");
});

test("the address comes from a verified Google id token", () => {
  const tok = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;
  assert.equal(emailFromIdToken(tok({ email: "Sam@Gmail.com", email_verified: true })), "sam@gmail.com");
  assert.equal(emailFromIdToken(tok({ email: "sam@gmail.com", email_verified: false })), null);
  assert.equal(emailFromIdToken("garbage"), null);
});

test("refresh tokens are encrypted and tamper-evident", async () => {
  const sealed = await sealToken("1//refresh-token");
  assert.ok(!sealed.includes("refresh"));
  assert.equal(await openToken(sealed), "1//refresh-token");
  const [iv, tag, enc] = sealed.split(".");
  await assert.rejects(openToken([iv, tag, enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA")].join(".")));
});

test("only real-looking addresses are emailed", () => {
  for (const ok of ["frontdesk@hotel.com", "reservations.miami@marriott.co.uk"]) assert.ok(validEmail(ok), ok);
  for (const bad of ["", "hotel", "a@b", "x@y.com, z@w.com", "<a@b.com>", "a b@c.com"]) assert.ok(!validEmail(bad), bad);
});
