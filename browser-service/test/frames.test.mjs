// Unit tests for newest-frame-wins delivery with a fake socket whose sends we complete by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, stopDelivery } from "../frames.mjs";

function fakeSocket() {
  const ws = { readyState: 1, bufferedAmount: 0, sent: [], callbacks: [] };
  ws.send = (data, _opts, cb) => {
    ws.sent.push(data);
    ws.bufferedAmount += data.length;
    ws.callbacks.push(() => {
      ws.bufferedAmount -= data.length;
      cb();
    });
  };
  ws.flushOne = () => ws.callbacks.shift()?.();
  return ws;
}
const frame = (n, size = 1000) => Object.assign(Buffer.alloc(size), { n });

test("one frame in flight; frames arriving meanwhile collapse to the newest", () => {
  const ws = fakeSocket();
  for (let i = 1; i <= 50; i++) deliver(ws, frame(i), 48 * 1024);
  assert.deepEqual(ws.sent.map((f) => f.n), [1], "only the first is sent while it's in flight");
  ws.flushOne();
  assert.deepEqual(ws.sent.map((f) => f.n), [1, 50], "then straight to the newest, skipping 2..49");
  ws.flushOne();
  assert.equal(ws.sent.length, 2);
  stopDelivery(ws);
});

test("never sends while the socket holds more than the limit; sends the newest once it drains", async () => {
  const ws = fakeSocket();
  ws.bufferedAmount = 60 * 1024; // e.g. status messages queued
  deliver(ws, frame(1), 48 * 1024, 10);
  deliver(ws, frame(2), 48 * 1024, 10);
  assert.equal(ws.sent.length, 0);
  ws.bufferedAmount = 0;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ws.sent.map((f) => f.n), [2]);
  stopDelivery(ws);
});

test("the socket's queue stays bounded under a flood from a slow reader", () => {
  const ws = fakeSocket();
  let peak = 0;
  for (let i = 1; i <= 1000; i++) {
    deliver(ws, frame(i, 30_000), 48 * 1024);
    peak = Math.max(peak, ws.bufferedAmount);
    if (i % 100 === 0) ws.flushOne(); // the reader occasionally catches up
  }
  assert.ok(peak <= 30_000, `peak queued ${peak} bytes`);
  assert.ok(ws.sent.length <= 11, `sent ${ws.sent.length} of 1000 frames`);
  assert.equal(ws.sent[ws.sent.length - 1].n % 100, 0, "each catch-up sends the newest frame at that moment");
  stopDelivery(ws);
});

test("closed sockets get nothing", () => {
  const ws = fakeSocket();
  ws.readyState = 3;
  deliver(ws, frame(1), 48 * 1024);
  assert.equal(ws.sent.length, 0);
});
