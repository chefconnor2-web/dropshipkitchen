// Newest-frame-wins delivery of live-view frames to one client (a WebSocket from `ws`): one frame in flight,
// one latest frame waiting (a newer one replaces it), and nothing more while the socket already holds
// `limit` bytes. A slow phone skips frames instead of falling behind, and gets the latest picture as soon as
// it catches up. Kept separate so it can be tested with a fake socket.

export function deliver(ws, jpeg, limit, retryMs = 40) {
  if (ws.readyState !== 1) return;
  if (ws.sendingFrame || ws.bufferedAmount > limit) {
    ws.nextFrame = jpeg;
    if (!ws.sendingFrame && !ws.frameRetry)
      ws.frameRetry = setTimeout(() => {
        ws.frameRetry = null;
        const next = ws.nextFrame;
        ws.nextFrame = null;
        if (next) deliver(ws, next, limit, retryMs);
      }, retryMs);
    return;
  }
  ws.sendingFrame = true;
  ws.send(jpeg, { binary: true }, () => {
    ws.sendingFrame = false;
    const next = ws.nextFrame;
    ws.nextFrame = null;
    if (next) deliver(ws, next, limit, retryMs);
  });
}

/** Stops a client's pending retry (on close). */
export function stopDelivery(ws) {
  if (ws.frameRetry) clearTimeout(ws.frameRetry);
  ws.frameRetry = null;
  ws.nextFrame = null;
}
