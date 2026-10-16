import { test } from "node:test";
import assert from "node:assert/strict";
import { robotCheck } from "../lib/connectors/links";

test("Google's robot check is spotted and the question pulled from the link", () => {
  const sorry = "https://www.google.com/sorry/index?continue=" + encodeURIComponent("https://www.google.com/search?q=How+will+Manitoba%27s+new+tax+work&udm=50");
  assert.deepEqual(robotCheck(sorry, "Our systems have detected unusual traffic from your computer network."), { blocked: true, question: "How will Manitoba's new tax work" });
  assert.deepEqual(robotCheck("https://www.google.com/search?q=48v+bms+wiring&udm=50", "About this page: unusual traffic from your computer network"), { blocked: true, question: "48v bms wiring" });
  assert.equal(robotCheck("https://example.com/article", "A normal article about batteries.").blocked, false);
});

test("an encoded token in q is not treated as the question", () => {
  assert.deepEqual(robotCheck("https://www.google.com/sorry/index?q=EgQ0Ml9aGJ3k4scGIjB", "unusual traffic from your computer network"), { blocked: true, question: null });
});
