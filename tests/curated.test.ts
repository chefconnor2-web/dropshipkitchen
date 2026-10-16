import { test } from "node:test";
import assert from "node:assert/strict";
import { CURATED_PICKS, SECTORS, curatedPick, impossibleClaim, picksFirst, picksFor, picksNamed } from "../lib/curated";
import { blockedListing } from "../lib/catalog-search";

test("impossible claims are caught", () => {
  assert.ok(impossibleClaim("18650 Lithium Battery 9900mAh 3.7V Rechargeable"));
  assert.ok(impossibleClaim("21700 battery 8800 mAh high capacity"));
  assert.ok(impossibleClaim("Rechargeable LED Headlamp 20000 Lumen"));
  assert.ok(impossibleClaim("12000000lm LED Headlamp"));
  assert.ok(impossibleClaim("15,000,000 LM Flashlight Tactical"));
  assert.ok(blockedListing("2PCS Brightest 9900000LM Headlamp"));
  assert.ok(blockedListing("Diet pill fast slimming"));
  assert.ok(impossibleClaim("48v 29Ah 18650 Li-Ion Battery Pack 13S3P"));
  assert.ok(impossibleClaim("48v Lithium Ion Battery 20Ah 1000W 13S3P 18650"));
});

test("honest listings pass", () => {
  for (const t of [
    "Samsung 18650 3500mAh 10A cell",
    "Molicel P45B 21700 4500mAh",
    "EVE LF280K LiFePO4 280Ah prismatic cell",
    "Rechargeable Headlamp 1200 Lumen",
    "Power bank 20000mAh 65W",
    "48V 30Ah 21700 13S6P pack",
    "48V 10.4Ah 18650 13S4P e-bike battery",
    "72V 3000W Electric Bike Conversion Kit Rear Drive",
    "DS3225 25kg Metal Gear High Torque Waterproof Digital Servo",
    "STM32F103C8T6 Minimum System Board Blue Pill",
    "STM32F411 Black Pill development board",
  ])
    assert.equal(blockedListing(t), false, t);
});

test("curated list is clean", () => {
  const pids = new Set<string>();
  for (const p of CURATED_PICKS) {
    assert.ok(!pids.has(p.pid), `duplicate ${p.pid}`);
    pids.add(p.pid);
    assert.ok(p.sector in SECTORS, p.pid);
    assert.ok(p.name.length > 3 && p.why.length > 10, p.pid);
    assert.equal(blockedListing(p.name), false, p.name);
  }
  for (const s of Object.keys(SECTORS)) assert.ok(picksFor(s as keyof typeof SECTORS).length > 0, `no picks for ${s}`);
});

test("picks rank first, stock before maybe", () => {
  const pick = CURATED_PICKS[0];
  const out = picksFirst([{ pid: "x1" }, { pid: pick.pid }, { pid: "x2" }]);
  assert.deepEqual(out.map((h) => h.pid), [pick.pid, "x1", "x2"]);
  assert.ok(curatedPick(pick.pid));
  const ev = picksFor("ev");
  assert.ok(ev.findIndex((p) => p.verdict === "maybe") > ev.findLastIndex((p) => p.verdict === "stock"));
});

test("picks are found by their own names", () => {
  assert.equal(picksNamed("UNI-T UT61D multimeter")[0]?.pid, "2505180301331600100");
  assert.equal(picksNamed("ut61d")[0]?.pid, "2505180301331600100");
  assert.equal(picksNamed("DS3225 servo")[0]?.pid, "1507640895695499264");
  assert.ok(picksNamed("heat shrink").length >= 1);
  assert.deepEqual(picksNamed("servo"), []);
  assert.deepEqual(picksNamed("garden hose"), []);
});
