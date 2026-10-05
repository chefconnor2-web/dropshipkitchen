// Tracking vocabulary and the per-parcel update rule. Nothing here calls CJ or the database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { combinedStage, stageOf, trackingLinks } from "../lib/carriers";
import { nextTracking } from "../lib/tracking";

test("stageOf sorts carrier wording into stages", () => {
  assert.equal(stageOf(null), "label");
  assert.equal(stageOf("Not Found"), "label");
  assert.equal(stageOf("Info Received"), "label");
  assert.equal(stageOf("In Transit"), "in_transit");
  assert.equal(stageOf("Arrived at destination country customs"), "in_transit");
  assert.equal(stageOf("Out for delivery"), "out_for_delivery");
  assert.equal(stageOf("Delivered"), "delivered");
  assert.equal(stageOf("Delivered, in mailbox"), "delivered");
  // Failures mention "deliver" too; they must never read as delivered.
  assert.equal(stageOf("Undelivered"), "exception");
  assert.equal(stageOf("Delivery attempt failed"), "exception");
  assert.equal(stageOf("Returned to sender"), "exception");
  assert.equal(stageOf("Held at customs"), "exception");
});

test("combinedStage is the least advanced parcel, or exception if any", () => {
  assert.equal(combinedStage([]), null);
  assert.equal(combinedStage(["delivered", "in_transit"]), "in_transit");
  assert.equal(combinedStage(["delivered", "delivered"]), "delivered");
  assert.equal(combinedStage(["delivered", "exception"]), "exception");
});

test("trackingLinks prefers the delivering carrier's own site, then the universal tracker", () => {
  const links = trackingLinks({ number: "CJPKL123", lastMileCarrier: "Canada Post", lastMileNumber: "LM 456" });
  assert.equal(links.length, 2);
  assert.equal(links[0].label, "Track on Canada Post");
  assert.ok(links[0].href.startsWith("https://www.canadapost-postescanada.ca/"));
  assert.ok(links[0].href.includes("LM%20456"));
  assert.ok(links[1].href.includes("17track") && links[1].href.includes("CJPKL123"));
  const only = trackingLinks({ number: "X1" });
  assert.deepEqual(only.map((l) => l.label), ["Track on 17TRACK"]);
  // An unknown carrier is named but tracked through the universal site.
  assert.equal(trackingLinks({ number: "X1", lastMileCarrier: "Speedy Local", lastMileNumber: "Q9" })[0].label, "Track with Speedy Local");
  assert.deepEqual(trackingLinks({ number: null }), []);
});

const blank = { trackingStage: null, trackingStatus: null, trackingEta: null, lastMileCarrier: null, lastMileNumber: null, shippedAt: null, deliveredAt: null };

test("nextTracking: a tracking number alone means shipped; CJ info moves it along; no change returns null", () => {
  const t0 = new Date("2026-10-01T00:00:00Z");
  assert.equal(nextTracking(blank, undefined, false, t0), null);
  const shipped = nextTracking(blank, undefined, true, t0)!;
  assert.equal(shipped.trackingStage, "label");
  assert.equal(shipped.shippedAt?.toISOString(), t0.toISOString());
  assert.equal(nextTracking(shipped, undefined, true, t0), null);
  const moving = nextTracking(shipped, { trackingNumber: "A", trackingStatus: "In transit", deliveryDay: "7-12", lastMileCarrier: "USPS", lastTrackNumber: "9400" }, true)!;
  assert.equal(moving.trackingStage, "in_transit");
  assert.equal(moving.trackingEta, "7-12");
  assert.equal(moving.lastMileCarrier, "USPS");
  assert.equal(moving.shippedAt?.toISOString(), t0.toISOString());
  const t1 = new Date("2026-10-09T00:00:00Z");
  const done = nextTracking(moving, { trackingNumber: "A", trackingStatus: "Delivered" }, true, t1)!;
  assert.equal(done.trackingStage, "delivered");
  assert.equal(done.deliveredAt?.toISOString(), t1.toISOString());
  assert.equal(done.lastMileCarrier, "USPS"); // kept when CJ stops sending it
  // A stale read can't un-deliver a parcel.
  assert.equal(nextTracking(done, { trackingNumber: "A", trackingStatus: "In transit" }, true), null);
});
