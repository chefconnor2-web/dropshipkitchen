// The parallel-tab pool: every job runs once, at most N at a time, results in input order, failures isolated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPool } from "../pool.mjs";

test("runs each job once on N workers, at most N at a time, results in order", async () => {
  let running = 0, peak = 0;
  const seen = [];
  const progress = [];
  const out = await runPool([1, 2, 3, 4, 5, 6, 7], ["a", "b", "c"], async (x, w) => {
    running++;
    peak = Math.max(peak, running);
    seen.push(w);
    await new Promise((r) => setTimeout(r, 10 + (x % 3) * 5));
    running--;
    if (x === 4) throw new Error("boom");
    return x * 10;
  }, (d, t) => progress.push(`${d}/${t}`));
  assert.equal(peak, 3);
  assert.deepEqual(out, [10, 20, 30, { error: "boom" }, 50, 60, 70]);
  assert.equal(progress.at(-1), "7/7");
  assert.deepEqual([...new Set(seen)].sort(), ["a", "b", "c"]);
});

test("fewer jobs than workers: idle workers do nothing", async () => {
  const out = await runPool(["x"], [1, 2, 3], async (j) => j + "!");
  assert.deepEqual(out, ["x!"]);
});
