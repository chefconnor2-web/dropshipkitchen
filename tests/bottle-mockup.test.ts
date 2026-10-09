// Bottle finder mock-ups: finding the one bottle in a CJ studio photo, and turning down photos we can't print on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findBottle } from "../lib/bottle-mockup";
import { podMarked } from "../lib/cj/normalize";

const W = 400;
const H = 400;

/** A light studio background with shaded upright cylinders (cx, half-width) from y=100 to y=360, under a lid. */
function photo(bottles: Array<[number, number]>, opts: { noisy?: boolean; streak?: boolean } = {}) {
  const px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const v = opts.noisy ? (x * 7 + y * 13) % 120 + 60 : 246;
      px[i] = px[i + 1] = px[i + 2] = v;
      for (const [cx, r] of bottles) {
        const nx = (x - cx) / r;
        const inBody = Math.abs(nx) < 1 && y >= 100 && y <= 360;
        const inLid = Math.abs(x - cx) < r * 0.7 && y >= 70 && y < 100;
        if (inLid) px[i] = px[i + 1] = px[i + 2] = 30;
        if (inBody) {
          const shade = 0.55 + 0.45 * Math.sqrt(1 - nx * nx);
          const streak = opts.streak && Math.abs(nx + 0.4) < 0.06;
          px[i] = streak ? 246 : 60 * shade;
          px[i + 1] = streak ? 246 : 90 * shade;
          px[i + 2] = streak ? 246 : 160 * shade;
        }
      }
    }
  return px;
}

test("findBottle measures the body of a single bottle", () => {
  const fit = findBottle(photo([[200, 60]]), W, H);
  assert.ok(fit);
  assert.ok(Math.abs(fit.cx - 200) <= 2, `cx ${fit.cx}`);
  assert.ok(Math.abs(fit.bodyW - 120) <= 4, `bodyW ${fit.bodyW}`);
  assert.ok(fit.cy > 150 && fit.cy < 330, `cy ${fit.cy}`);
});

test("findBottle sees through a reflection streak", () => {
  const fit = findBottle(photo([[200, 60]], { streak: true }), W, H);
  assert.ok(fit);
  assert.ok(Math.abs(fit.bodyW - 120) <= 4, `bodyW ${fit.bodyW}`);
});

test("findBottle turns down colour line-ups and busy backgrounds", () => {
  assert.equal(findBottle(photo([[90, 40], [200, 40], [310, 40]]), W, H), null);
  assert.equal(findBottle(photo([[200, 60]], { noisy: true }), W, H), null);
  assert.equal(findBottle(photo([]), W, H), null);
});

test("podMarked spots CJ's customization fields", () => {
  assert.equal(podMarked({ id: "1", isPod: 1 }), true);
  assert.equal(podMarked({ id: "1", customizationVersion: "3" }), true);
  assert.equal(podMarked({ id: "1", isPod: 0, customization: "" }), false);
  assert.equal(podMarked({ id: "1", nameEn: "Custom logo bottle" }), false);
});
