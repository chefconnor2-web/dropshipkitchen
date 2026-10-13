# Frontier port: shared contracts

The architecture from `chefconnor2-web/workflow-agent-cart` (read-only reference, revision `78b5259`) is adapted here to Chit (Frontier). These contracts are **frozen** for parallel work. Changes go through the coordinator.

Shared types live in code. Where code and this document disagree, the code wins:
- `lib/run-shared.ts`: run statuses, `PendingStep`, `RunSnapshot`, `RunFrame` (SSE), `ResumeResult`, `CancelResult`, `RunAccepted`, the `applyEvent` / `applyFrame` reducers, `formatSse` and `SseParser`.
- `components/chat/run-context.ts`: what a browser card gets from the chat (`chatId`, `pending`, `runStatus`, `resume`).
- `lib/flights-shared.ts` `BrowserCard`: `{ kind: "browser", id: "br_"+session, session, site, handoff?, group? }`. It no longer carries a live URL or token.
- `prisma/schema.prisma`: `AssistantRun`, `AssistantChat.browserSessionId`.

## 1. Deployment and ownership (explicit single-worker model)

Railway project `tetherless`, environment `preview`. Both services run **1 replica** (`multiRegionConfig.sfo.numReplicas = 1`).
- `storefront` (Next.js 15, `next start`, SQLite on a volume at `/data`) is the only process that executes runs. It owns them in memory through `processSingleton("assistant-runs")` in `lib/runs.ts`:
  - the AbortController per run;
  - the waiter for the pending step;
  - the event ring buffer and live subscribers.

  Durable state (status, partial reply, pending step, error) lives in the `AssistantRun` table.
- `chit-browser` (browser-service, Puppeteer) owns its browser sessions in memory.
- Scaling either service beyond 1 replica is unsupported. SQLite alone already forbids it for the storefront. Running more replicas would need sticky routing plus a shared bus, and that is out of scope.

**Process loss.**
- *Storefront restart:* at boot (`instrumentation.ts`), every run in `queued` / `running` / `waiting` is marked `interrupted` with the error "Neon restarted before finishing. Tap retry." Its pending step is cleared, and the shopper's message is marked `failed: true` in `uiJson`, so it is never lost. The run is not resumed automatically: the inputs (docs up to 1M characters) are not persisted, and a half-finished tool loop is unsafe to replay.
- *Browser-service restart:* its sessions vanish. The next browser step gets 404, and `inBrowser` opens a fresh session. A step waiting on a lost browser stays waiting until the shopper resumes or it expires. After resume, Neon sees the new page state.

## 2. Identifiers
| id | format | owner |
|---|---|---|
| chatId | cuid (existing `AssistantChat.id`) | storefront DB |
| runId | cuid (`AssistantRun.id`) | storefront DB |
| clientRequestId | client `crypto.randomUUID()` per send, 8–64 chars `[A-Za-z0-9_-]` | client; unique per chat |
| user entry id | `"u_" + runId` | set on accept |
| assistant entry id | `runId` | set on completion (also the stable key of the live bubble) |
| stepId | `"st_" + 16 random base64url chars` | storefront run registry |
| browser session id | browser service id | chit-browser |
| browser card id | `"br_" + sessionId` | connector |

`UiEntry` additions (all optional, so old chats stay valid):
- user: `id`, `runId`, `failed?: boolean`;
- assistant: `id`, `stopped?: boolean`.

**Failed user entries are not in `messagesJson`.** Every count of user turns that maps `uiJson` onto `messagesJson` (edit/regenerate in `chatTurn`) must skip `failed` entries.

## 3. Ownership and auth
Ownership is unchanged and comes from `lib/chat-session.ts`: a chat is reachable only through `findOwnChat(chatId)`, which means the signed-in `customerId`, or the `cs_vid` visitor when the chat has no customer. Every run route resolves `run → chat` and then requires `findOwnChat`. A non-owner, or someone logged out, gets **404** (we don't reveal existence).

POST routes are same-origin JSON. They check that `Origin` (when present) matches the request host, and reject other origins with 403. Cookies are `SameSite=Lax`.

The browser live view is authorized by a token minted on demand by `GET /api/assistant/browser?chat=<chatId>&session=<sessionId>`:
- It requires owning the chat **and** `chat.browserSessionId === session`.
- It returns `{ url: "wss://…/live?id=<sid>&exp=<unix>&token=<hmac>", expiresAt }`.
- The token is `HMAC-SHA256(BROWSER_SERVICE_SECRET, "live." + sid + "." + exp)` in base64url. `exp` is now + 10 minutes. The service rejects expired or bad tokens at upgrade with 401.
- An open socket survives expiry. A reconnect fetches a new token.
- Tokens are never stored in `uiJson`. Old cards with `live` are ignored, and a card without a session shows "This browser has closed."
- The service also checks the `Origin` header against `ALLOWED_ORIGINS` (comma list) when that env var is set.

The storefront → browser-service HTTP API is authorized by the `x-browser-secret` header (unchanged).

## 4. Run lifecycle
```
POST create ─▶ queued ─▶ running ⇄ waiting ─▶ completed
                  │          │         │
                  └──────────┴─────────┴──▶ failed | cancelled | interrupted (boot)
```
- **One active run per chat.** Creating while another run is active returns 409 `{ error, activeRun: RunSnapshot }`.
- **Process limit.** `ASSISTANT_MAX_ACTIVE_RUNS` (default 12). Above it, the create call returns 503 "Neon is busy".
- `waiting` means a `PendingStep` is set and the tool loop is blocked in `ctx.waitForShopper`. The automated browser does nothing while waiting.
- `completed`: `uiJson` and `messagesJson` were saved by `chatTurn`. The assistant entry has `id = runId`.
- `cancelled`: the partial reply is saved as an assistant entry with `stopped: true`. The user message and the partial assistant text are also appended to `messagesJson`, so the history stays alternating. An empty partial gets the text "(stopped)".
- `failed`: the user entry gets `failed: true`, and `run.error` carries the shopper-facing message. For edits, `priorUiJson` is restored, so the old transcript comes back and nothing is half-deleted.

## 5. HTTP API (storefront)
All responses are JSON unless noted. Every error body has the shape `{ error: string }`.

**`GET /api/assistant?chat=<id>`** (existing) adds `activeRun: RunSnapshot | null` (the chat's queued/running/waiting run) and `lastRun: RunSnapshot | null` (the most recent run, for showing interrupted/failed state). `entries` include the provisional user entry of an active run.

**`POST /api/assistant/runs`** body `{ clientRequestId, message, chatId?, images?, voice?, editIndex?, docs? }` (same validation as the old POST plus `clientRequestId`):
- 202 `RunAccepted`. The response is sent **before** any model call. The user entry is already saved in `uiJson` at `run.userIndex`, provisionally.
- 200 `RunAccepted` with `duplicate: true` when `(chatId, clientRequestId)` already exists. Nothing new is started.
- 400 / 402 (`{ error, limit, plans }` like before) / 404 (chat not yours) / 409 (active run) / 429 / 503.
- A new chat is created when `chatId` is absent, and its title is generated in the background (a `title` frame).

**`GET /api/assistant/runs/<runId>`** returns 200 `{ run: RunSnapshot, done: RunDone | null }`, or 404.

**`GET /api/assistant/runs/<runId>/events?after=<seq>`** returns `text/event-stream` (`cache-control: no-store`, `x-accel-buffering: no`).
- The first frame is a `snapshot` unless `after` is given **and** every frame after it is still in the ring buffer (the last 2000 frames). In that case only the frames with seq > after are sent.
- After that come live frames.
- A comment `: ping` is sent every 15 s.
- For a run that already finished, the stream sends the snapshot, plus `done` if it completed, then closes. The server closes after the terminal frame (`done` or a terminal `status`).
- The client reconnects with `after = last seq seen`.

**`POST /api/assistant/runs/<runId>/cancel`** returns 200 `CancelResult`:
- `cancelled: true` when an active run was stopped;
- `cancelled: false` with the final snapshot when it had already finished (still 200: nothing is wrong).

Cancelling while waiting resolves the waiter as cancelled, and the run ends `cancelled`.

**`POST /api/assistant/runs/<runId>/resume`** body `{ stepId }` returns a `ResumeResult`:
- **200 `{ accepted: true, runId, stepId, status: "running" }`** only when the run is `waiting` on exactly `stepId`. Before replying, the server:
  1. clears the pending step in the DB;
  2. emits `pending: null` and `status: running`;
  3. asks the browser service to release shopper control (`POST /sessions/<sid>/release`);
  4. wakes the waiter.
- **200 `{ accepted: true, duplicate: true, ... }`** when `stepId === lastResumedStep` and the run hasn't paused again since (a retry of an accepted resume).
- **409 `{ accepted: false, reason, message, current }`**:
  - `stale_step`: waiting on a different step (a newer pause). `current.pending` is the newer step.
  - `not_waiting`: running, not paused.
  - `run_finished`: terminal.
  - `expired`: the step timed out.
- 404 when the run isn't yours.

**Clients must check `accepted === true && stepId === <sent>`, never HTTP status alone.**

## 6. Run frames (SSE)
The types are in `lib/run-shared.ts` (`RunFrame`). The server assigns `seq = 1, 2, 3…` per run, strictly increasing, and every frame carries it. The client folds frames with `applyFrame`. It ignores frames with seq ≤ its snapshot's seq, and a `snapshot` frame replaces its state.

**Frames:** `snapshot`, `event` (a `LiveEvent`: progress / found / items / text / thinking / break / react), `status`, `pending`, `title`, `done`.

**Persistence.** The server writes `partialJson` + `seq` to the DB **at most every 750 ms** while running, and immediately on status or pending changes and at the end. A snapshot always reflects the in-memory state when the process is alive. After a restart it comes from the DB.

**Stable identity.**
- The live bubble's key is the runId.
- On `done`, the client replaces the live bubble with `done.entry` (id = runId), in place, never appending a second copy.
- On refetch of `GET /api/assistant`, entries carry ids. The client drops a live bubble whose runId already appears as an entry id.

## 7. Take over (pending steps)
`ConnectorContext` gains:
```ts
signal: AbortSignal;                      // aborted when the run is cancelled
waitForShopper(step: {
  kind: PendingKind;
  message: string;
  browser: { sessionId: string; cardId: string } | null;
}): Promise<{ outcome: "resumed" | "cancelled" | "expired"; stepId: string }>;
```
- `waitForShopper` creates the `PendingStep` with expiry `ASSISTANT_WAIT_MINUTES` (default 15), persists it, emits `pending`, sets status `waiting` and blocks. Only one pending step exists per run at a time.
- `resumed`: the connector reads the page state again and returns it, with a screenshot, to the model, which continues in the same run.
- `expired` / `cancelled`: the tool returns a message and the run ends its turn politely. When cancelled, the run aborts.

**Amazon connector.**
- When a page `needsShopper` (captcha, sign-in, interstitial), the connector calls `waitForShopper` automatically, with kind `captcha` / `sign_in` / `blocked`.
- `browser_hand_over` (checkout, choice) also blocks on `waitForShopper` instead of ending the turn.
- Neon never types credentials and never places orders.

**Client presentation.** Run execution state, browser connection state and presentation mode are three separate things:
- presentation mode: `inline` | `expanded-voluntary` | `expanded-required`;
- connection state: `connecting | live | reconnecting | offline | ended`.

Rules:
1. When `pending` is set and `pending.browser.cardId` matches a card, that card enters `expanded-required`. This is the same component instance, rendered full-size via a portal, with the same socket kept. The banner shows `pending.message` and a primary **"Done — continue"** button. It also takes shopper control (`{t:"control", on:true}`).
2. "Done — continue" calls `resume(stepId)`:
   - `accepted && stepId matches` → return to inline, restoring scroll and focus.
   - Not accepted with `stale_step` → stay expanded and show `current.pending` (the newer step).
   - Not accepted with `run_finished`, `expired` or `not_waiting` → collapse and show the message inline.
   - A network error → stay expanded with "Couldn't reach Neon. Try again."
   - A delayed acknowledgement for an old stepId **must not** collapse a newer pause. Compare against the latest `pending.id` from the stream.
3. **Voluntary expansion is not approval.** "Take over" expands and takes control. "Hand back to Neon" releases control and collapses, and never calls resume. A required takeover can't be dismissed without resuming, except by cancelling the run (Stop).
4. While expanded: the chat stays mounted (portal), so the composer draft, attachments, chat scroll position and the browser socket all persist. The inline slot keeps its measured height so the chat doesn't jump. Focus moves into the dialog (to the instruction text) and goes back to the element that had it, or to the card, when collapsing.

## 8. Browser service transport (`browser-service/server.mjs`)

**WS `/live?id&exp&token`, binary out.** Each binary message is one JPEG frame, newest-wins.
- Each client has at most **one frame in flight** plus **one latest frame waiting**. A newer frame overwrites the waiting one.
- A frame is never sent when `ws.bufferedAmount > FRAME_QUEUE_BYTES` (default 48 KiB). It waits as the "latest" until the send callback drains.
- Slow observers therefore skip frames and never replay stale ones.

**Screencast settings.** JPEG quality `SCREENCAST_QUALITY` (default 60), `everyNthFrame` 1. Every frame is acked to CDP immediately. Max size is the viewport (desktop 1280×800, phone 390×844 @ DPR 2).

**JSON out:**
- `{t:"status", url, title, needs, mode, control}`;
- `{t:"frame-meta", w, h}` (when the frame size changes);
- `{t:"focus", editing}`;
- `{t:"control", on, by:"shopper"|"server"}`;
- `{t:"ack", n}`;
- `{t:"error", n?, code, message}`;
- `{t:"ended", reason}`.

**JSON in** (`maxPayload` 16 KiB). Every message may carry `n` (a client sequence number):
- `{t:"control", on}`;
- `{t:"tap", x, y}`, normalized 0..1 in the frame;
- `{t:"scroll", dy}`, page px, clamped to ±4000;
- `{t:"type", text}`, ≤ 2000 chars;
- `{t:"key", key}`, allowlisted: Enter, Backspace, Tab, Escape, ArrowUp, ArrowDown, ArrowLeft, ArrowRight;
- `{t:"back"}`.

**Input validation.**
- Input other than `control` is accepted only while the session is under shopper control and from the controlling socket.
- Invalid input → `{t:"error", code:"invalid"}`. Nothing is dropped silently.

**Input ordering.** Input runs in one serialized queue per session, in arrival order.
- Consecutive not-yet-started `scroll` items are coalesced by summing `dy`.
- The queue is bounded at 64 items. When full, the new item is rejected with `{t:"error", code:"busy"}`.
- Each executed item is acked `{t:"ack", n}`. A failure is reported `{t:"error", n, code:"failed"}` and **never retried** (clicks and typing aren't idempotent).
- Navigation (`back`) waits for the load inside its queue slot, so later input applies to the new page.

**HTTP API (`x-browser-secret`):** `POST /sessions`, `/sessions/:id/act|amazon/search|amazon/add|amazon/cart`, plus:
- `POST /sessions/:id/release`: shopper control off, then desktop mode, then `{t:"control", on:false, by:"server"}` to clients;
- `DELETE /sessions/:id`: end the session and free resources.

Agent steps while the shopper has control → 409 (unchanged).

**Lifecycle and cleanup.**
- Idle sessions close after `IDLE_MINUTES` (unchanged).
- `browser.on("disconnected")` ends every session and tells clients `{t:"ended"}`, and the next create relaunches Chrome.
- A page crash (`page.on("error")`) ends that session.
- Session count is capped by `MAX_SESSIONS`.
- Sockets are pinged every 30 s, and dead ones are terminated.

**Navigation policy.** Amazon hosts only. Private, loopback and link-local addresses are blocked (existing guard). Typed text, frames and cookies are never logged.

## 9. Client transports
- **Run stream:** `fetch` + `ReadableStream` + `SseParser` (not EventSource, so we see HTTP statuses).
  - Reconnect with backoff 0.5, 1, 2, 4, 8, 8 s (6 tries), each time with `?after=<last seq>`. After the tries run out, show "Connection lost — tap to reconnect" and do one `GET /runs/:id` snapshot.
  - Reconnect also happens on `visibilitychange → visible` and `online`.
  - A 404 stops reconnecting.
- **Live browser:** WebSocket with `binaryType = "blob"`.
  - Rendering: an imperative `<canvas>` with `createImageBitmap`. At most one decode runs at a time, and only the latest pending blob is decoded next. Each bitmap is `.close()`d. A fallback `<img>` with object URLs revokes the previous one.
  - No React state per frame.
  - Reconnect: fetch a token, then backoff 0.5, 1, 2, 4, 8 s (5 tries), then "Tap to reconnect". It reconnects only while the card is visible or expanded.

## 10. Limits
| name | default | where |
|---|---|---|
| ASSISTANT_MAX_ACTIVE_RUNS | 12 | storefront |
| ASSISTANT_WAIT_MINUTES | 15 | storefront |
| run ring buffer | 2000 frames | storefront |
| partial flush | 750 ms | storefront |
| SSE ping | 15 s | storefront |
| FRAME_QUEUE_BYTES | 49152 | browser |
| SCREENCAST_QUALITY | 60 | browser |
| input queue | 64 | browser |
| WS maxPayload | 16 KiB | browser |
| view token TTL | 10 min | storefront mints, browser checks |
