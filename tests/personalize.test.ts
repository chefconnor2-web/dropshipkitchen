// Print-on-demand personalization: the podProperties CJ prints from, the merchant set-up, and image checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPodProperties, coverRect, designerConfig, normalizeConfig, parsePersonalizeConfig, podUrls, POD_PROPERTIES_MAX } from "../lib/personalize-shared";
import { podSiteProblem, sniffImage } from "../lib/personalize";
import { buildCjOrderBody } from "../lib/fulfillment";

const urls = podUrls("https://shop.example.com/", "cmabc123");

test("podUrls builds the public artwork and mock-up links", () => {
  assert.deepEqual(urls, { art: "https://shop.example.com/pod/cmabc123/art", preview: "https://shop.example.com/pod/cmabc123/preview" });
});

test("POD 2.0 sends the print area and artwork link", () => {
  const v = buildPodProperties({ podVersion: 2, areaName: "LogoArea" }, urls.art, urls.preview);
  assert.deepEqual(JSON.parse(v), [{ areaName: "LogoArea", links: [urls.art], type: "1" }]);
});

test("POD 3.0 sends the production image and exactly one mock-up", () => {
  const v = buildPodProperties({ podVersion: 3, areaName: "ignored" }, urls.art, urls.preview);
  assert.deepEqual(JSON.parse(v), [{ links: [urls.art], effectImgs: [urls.preview] }]);
});

test("podProperties longer than CJ's 500 characters is refused", () => {
  const long = "https://" + "a".repeat(POD_PROPERTIES_MAX) + ".com/pod/x/art";
  assert.throws(() => buildPodProperties({ podVersion: 2, areaName: "LogoArea" }, long, long), /too long for CJ/);
});

test("set-up values are clamped, and a set-up allowing nothing is off", () => {
  const c = normalizeConfig({ podVersion: 7 as never, maxTextLength: 9999, artWidth: 10, box: { x: 0.9, y: -1, w: 0.5, h: 2 } })!;
  assert.equal(c.podVersion, 2);
  assert.equal(c.maxTextLength, 200);
  assert.equal(c.artWidth, 200);
  assert.ok(c.box.x + c.box.w <= 1 + 1e-9 && c.box.y === 0 && c.box.y + c.box.h <= 1);
  assert.equal(normalizeConfig({ allowPhoto: false, allowText: false }), null);
  assert.equal(parsePersonalizeConfig("not json"), null);
  assert.equal(parsePersonalizeConfig(null), null);
});

test("the storefront designer config leaves out CJ's own terms", () => {
  const d = designerConfig(normalizeConfig({ areaName: "LogoArea", podVersion: 3 }))!;
  assert.ok(!("areaName" in d) && !("podVersion" in d));
  assert.equal(designerConfig(null), null);
});

test("coverRect fills the box and moves within it", () => {
  const center = coverRect(2000, 1000, 500, 500);
  assert.deepEqual(center, { x: -250, y: 0, w: 1000, h: 500 });
  assert.equal(coverRect(2000, 1000, 500, 500, 1, 1).x, -500); // right edge
  assert.equal(coverRect(2000, 1000, 500, 500, 1, -1).x, 0); // left edge
  assert.equal(coverRect(1000, 1000, 500, 500, 2).w, 1000); // zoomed
});

test("sniffImage accepts only real PNG and JPEG bytes", () => {
  assert.equal(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), "image/png");
  assert.equal(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0])), "image/jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>")), null);
});

test("podSiteProblem requires a public https SITE_URL", () => {
  assert.equal(podSiteProblem("https://storefront.up.railway.app"), null);
  assert.match(podSiteProblem("http://localhost:3000")!, /public https/);
  assert.match(podSiteProblem("https://127.0.0.1")!, /public https/);
  assert.match(podSiteProblem("nope")!, /not a valid/);
});

test("buildCjOrderBody puts podProperties on personalized lines only", () => {
  const pod = buildPodProperties({ podVersion: 2, areaName: "LogoArea" }, urls.art, urls.preview);
  const body = buildCjOrderBody({
    orderNumber: "T-1",
    email: null,
    customerName: "Sam",
    phone: null,
    ship: { name: "Sam", address: { line1: "1 Main", city: "Bend", state: "OR", country: "US", postal_code: "97701" } },
    logisticName: "USPS+",
    fromCountryCode: "CN",
    sandbox: true,
    items: [
      { vid: "V1", quantity: 1, lineItemId: "a", podProperties: pod },
      { vid: "V1", quantity: 2, lineItemId: "b" },
    ],
  });
  assert.equal(body.products[0].podProperties, pod);
  assert.ok(!("podProperties" in body.products[1]));
  assert.equal(body.products.length, 2); // two designs of one variant stay separate lines
});
