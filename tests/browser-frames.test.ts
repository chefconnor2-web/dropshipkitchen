// The live browser's pure parts: where a tap lands in the remote page (letterbox-aware), how far a drag
// scrolls, the reconnect schedule, and newest-frame-wins rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameRenderer, containRect, pageSize, reconnectDelay, scrollDelta, toFramePoint } from "../components/chat/browser-frames";

const box = (width: number, height: number) => ({ left: 10, top: 20, width, height });

test("contain: a portrait phone frame in a landscape box is centred with side bars", () => {
  const r = containRect(box(800, 400), { w: 390, h: 844 })!;
  assert.ok(Math.abs(r.height - 400) < 1e-9);
  assert.ok(Math.abs(r.left - (10 + (800 - r.width) / 2)) < 1e-9);
});

test("taps map to the frame; taps in the bars are ignored; device pixel ratio doesn't matter", () => {
  const b = box(800, 400);
  const r = containRect(b, { w: 780, h: 1688 })!;
  const mid = toFramePoint(r.left + r.width / 2, r.top + r.height / 4, b, { w: 780, h: 1688 })!;
  assert.ok(Math.abs(mid.x - 0.5) < 1e-9 && Math.abs(mid.y - 0.25) < 1e-9);
  // Same page at DPR 1 and DPR 2 (390×844 vs 780×1688): the same normalized point.
  const one = toFramePoint(r.left + r.width / 2, r.top + r.height / 4, b, { w: 390, h: 844 })!;
  assert.deepEqual(one, mid);
  assert.equal(toFramePoint(b.left + 5, b.top + 100, b, { w: 780, h: 1688 }), null, "left bar");
  assert.equal(toFramePoint(b.left + 400, b.top + 500, b, { w: 780, h: 1688 }), null, "below the box");
});

test("drag scrolls in the remote page's own pixels", () => {
  // A 390-wide page drawn 195 px wide (half size): 10 screen px = 20 page px.
  const b = box(195, 422);
  assert.equal(Math.round(scrollDelta(10, b, { w: 780, h: 1688 }, { w: 390, h: 844 })), 20);
  assert.equal(scrollDelta(1e9, b, { w: 780, h: 1688 }, { w: 390, h: 844 }), 4000, "clamped");
  assert.deepEqual(pageSize(null, { w: 780, h: 1688 }), { w: 390, h: 844 }, "high-density phone capture halves");
  assert.deepEqual(pageSize(null, { w: 1280, h: 800 }), { w: 1280, h: 800 });
});

test("reconnect waits 0.5, 1, 2, 4, 8 s, then stops", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => reconnectDelay(n)), [500, 1000, 2000, 4000, 8000]);
  assert.equal(reconnectDelay(6), null);
  assert.equal(reconnectDelay(0), null);
});

test("renderer decodes only the newest pending frame and frees every decoded frame once", async () => {
  const decoded: number[] = [];
  const drawn: number[] = [];
  const released: number[] = [];
  let finishDecode: (() => void) | null = null;
  const r = new FrameRenderer<number, { width: number; height: number; n: number }>({
    decode: (n) =>
      new Promise((res) => {
        decoded.push(n);
        finishDecode = () => res({ width: 10, height: 10, n });
      }),
    draw: (f) => drawn.push(f.n),
    release: (f) => released.push(f.n),
    schedule: (cb) => cb(),
  });
  r.push(1);
  for (let i = 2; i <= 20; i++) r.push(i); // arrive while frame 1 decodes
  assert.deepEqual(decoded, [1]);
  finishDecode!();
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(decoded, [1, 20], "skips straight to the newest");
  finishDecode!();
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(drawn, [1, 20]);
  assert.deepEqual(released, [1, 20]);
  assert.ok(r.hasFrame);
  r.dispose();
});
