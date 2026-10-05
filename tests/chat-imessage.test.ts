// iMessage-style chat helpers: tapback parsing and timestamps. Nothing here calls the AI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReaction, REACTIONS } from "../lib/assistant";
import { showStamp, stampLabel } from "../components/chat/ui";

test("parseReaction keeps only the allowed tapbacks", () => {
  assert.equal(parseReaction("👍"), "👍");
  assert.equal(parseReaction(" 🔥\n"), "🔥");
  assert.equal(parseReaction("❤"), "❤️"); // without the variation selector, still the heart
  assert.equal(parseReaction("❤️"), "❤️");
  assert.equal(parseReaction("🛠"), "🛠️");
  assert.equal(parseReaction("none"), null);
  assert.equal(parseReaction("😂"), null); // never laughs at a request
  assert.equal(parseReaction("👎"), null);
  assert.equal(parseReaction(""), null);
  assert.ok(REACTIONS.length >= 10);
});

test("stampLabel reads like iMessage", () => {
  const now = new Date(2026, 9, 5, 15, 0);
  assert.match(stampLabel(new Date(2026, 9, 5, 14, 14).toISOString(), now), /^Today 2:14\sPM$/);
  assert.match(stampLabel(new Date(2026, 9, 4, 9, 2).toISOString(), now), /^Yesterday 9:02\sAM$/);
  assert.match(stampLabel(new Date(2026, 9, 1, 9, 2).toISOString(), now), /^Thursday 9:02\sAM$/);
  assert.match(stampLabel(new Date(2026, 8, 3, 9, 2).toISOString(), now), /^Sep 3, 2026 at 9:02\sAM$/);
});

test("showStamp: first message, then only after an hour's gap", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 9, 5, 12, m)).toISOString();
  const e = [{ at: t(0) }, { at: t(1) }, {}, { at: t(30) }, { at: t(95) }];
  assert.equal(showStamp(e, 0), t(0));
  assert.equal(showStamp(e, 1), null);
  assert.equal(showStamp(e, 2), null); // old messages without a time show none
  assert.equal(showStamp(e, 3), null);
  assert.equal(showStamp(e, 4), t(95));
});
