// Share links: every network gets the link (tagged with where it was shared) and the text, safely encoded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shareTargets, taggedUrl } from "../lib/share";

const url = "https://chit.example/products/solar-kit";
const text = "Solar kit & cables on Chit";

test("taggedUrl adds utm tags and keeps existing params", () => {
  const t = new URL(taggedUrl(`${url}?v=2`, "whatsapp"));
  assert.equal(t.searchParams.get("v"), "2");
  assert.equal(t.searchParams.get("utm_source"), "whatsapp");
  assert.equal(t.searchParams.get("utm_medium"), "social");
  assert.equal(taggedUrl("not a url", "x"), "not a url");
});

test("every major network is offered, each with its own tagged link", () => {
  const targets = shareTargets(url, text, "https://chit.example/media/img1");
  assert.deepEqual(
    targets.map((t) => t.id),
    ["whatsapp", "facebook", "messenger", "x", "threads", "bluesky", "linkedin", "reddit", "pinterest", "telegram", "sms", "email"],
  );
  for (const t of targets) {
    const decoded = decodeURIComponent(t.href);
    assert.ok(decoded.includes(`${url}?utm_source=${t.id}`), `${t.id} carries its tagged link`);
    // The "&" in the text must not break the share URL's own query string.
    assert.ok(!t.href.includes("Solar kit & cables"), `${t.id} encodes the text`);
  }
  const pin = targets.find((t) => t.id === "pinterest")!;
  assert.ok(pin.href.includes(`media=${encodeURIComponent("https://chit.example/media/img1")}`));
  assert.equal(targets.find((t) => t.id === "messenger")!.mobileOnly, true);
});

test("Pinterest without a picture leaves media out", () => {
  const pin = shareTargets(url, text).find((t) => t.id === "pinterest")!;
  assert.ok(!pin.href.includes("media="));
});
