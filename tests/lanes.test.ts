// The CJ call line: urgent work (a shopper's tap) runs before background work queued earlier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeThrottle, withCjPriority, currentCjLane, type CjLane } from "../lib/cj/lanes";

test("an urgent call jumps ahead of background calls already waiting", async () => {
  const throttled = makeThrottle(() => 5);
  const order: string[] = [];
  const call = (name: string) => throttled(async () => void order.push(name));
  const all = [
    withCjPriority("background", () => call("bg1")),
    withCjPriority("background", () => call("bg2")),
    withCjPriority("background", () => call("bg3")),
    withCjPriority("urgent", () => call("tap")),
    call("normal"),
  ];
  await Promise.all(all);
  // bg1 starts at once; everything after it is picked by priority.
  assert.deepEqual(order, ["bg1", "tap", "normal", "bg2", "bg3"]);
});

test("promoting a lane moves its waiting calls ahead", async () => {
  const throttled = makeThrottle(() => 5);
  const order: string[] = [];
  const lane: CjLane = { priority: 0 };
  const all = [
    withCjPriority("normal", () => throttled(async () => void order.push("first"))),
    withCjPriority("normal", () => throttled(async () => void order.push("other"))),
    withCjPriority(lane, () => throttled(async () => void order.push("import"))),
  ];
  lane.priority = 2;
  await Promise.all(all);
  assert.deepEqual(order, ["first", "import", "other"]);
});

test("a failing call rejects its caller and the line keeps going", async () => {
  const throttled = makeThrottle(() => 1);
  const bad = throttled(async () => {
    throw new Error("boom");
  });
  const good = throttled(async () => "ok");
  await assert.rejects(bad, /boom/);
  assert.equal(await good, "ok");
});

test("calls outside any context get a fresh normal lane", () => {
  assert.equal(currentCjLane().priority, 1);
  assert.notEqual(currentCjLane(), currentCjLane());
});
