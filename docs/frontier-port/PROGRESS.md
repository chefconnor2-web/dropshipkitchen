# Frontier port: progress

## Baseline (T01)
- Destination: `/home/user/dropshipkitchen`, branch `claude/frontier-port`, cut from `claude/cart-filler-parity` (PR #48, unmerged). Base: `preview`.
- Source: `/home/user/workflow-agent-cart` @ `78b52595671be10d7565cfcfbe71c54df4dc1d9d`, read-only.
- Stack: Next.js 15.5 / React 19, Prisma 6 + SQLite (`/data` volume, `prisma db push` at boot in `scripts/start.sh`), Anthropic SDK 0.131 beta streaming, cookie auth (`lib/session.ts`, `lib/chat-session.ts`). The browser service is Node 22 + puppeteer-core 23.11.1 + ws 8.18.0.
- Deployment: both `storefront` and `chit-browser` have `numReplicas: 1` (verified via Railway get-service-config).
- Baseline checks: `npx tsc --noEmit` passes; `npm test` is 119/119 pass. There are no unrelated failures.
- Test harness, from the earlier session's scratchpad `/tmp/claude-0/-home-user-dropshipkitchen/e60e0a1f-…/scratchpad`:
  - playwright-core;
  - fake Anthropic servers (`fake-browser2.cjs` on :3301, used via `ANTHROPIC_BASE_URL`);
  - fixture pages (`fixture2.cjs` on :4556);
  - a browser-service smoke test (`svc-test.mjs`; the service runs with `BROWSER_TEST_ALLOW=1`, `CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`).

## Log
- T01 done: the mapping is in CONTRACTS.md §1 and in the task board.
- T02 done: shared code frozen (`lib/run-shared.ts`, `components/chat/run-context.ts`, schema, BrowserCard).
- T03–T07 are in progress in parallel. Four agents work on non-overlapping files (see PLAN.md owners).
- The e2e harness lives outside the repo, in the session scratchpad, at `/tmp/claude-0/-home-user/e60e0a1f-6794-5e4f-bca7-7f0c072d7514/scratchpad/e2e/`:
  - `stack.sh start|storefront|stop-storefront|stop` starts the fake model on :3301, the fixture on :4556, the browser service on :8099 and the production storefront on :3100.
  - `journey.cjs` drives a 390×844 touch phone viewport: required take-over → tap → Done → resume acknowledged → chat continues. It also covers refresh while paused, a delayed ack against a newer pause, duplicate and stale resumes, cancel during a wait, offline reconnect, and non-owner 404s.
  - `process-loss.cjs` covers a restart while a run is waiting, which should end as `interrupted`.

## Execution note
- **Session limit, 16:2x UTC:** the four parallel implementation agents all stopped on the account session limit (HTTP 429, resetting at 19:00 UTC). Before stopping they had produced:
  - `lib/run-client.ts` and `tests/run-client.test.ts`, kept as written;
  - `components/chat/browser-frames.ts`, kept as written.
- **Sequential implementation:** the coordinator implemented the rest one task after another:
  - `lib/runs.ts` and the routes;
  - the `chatTurn` changes;
  - the browser service;
  - `lib/browser.ts` and the token route;
  - the Amazon connector;
  - `BrowserView.tsx`;
  - `Chat.tsx`.
- **Review:** once agents were available again, a review workflow ran on the integrated diff.

## Evidence (T03–T09)
All commands ran in this sandbox. Local loopback, 4 CPUs, headless Chromium 1194, fake Anthropic server, production build (`next build && next start`).

- **Unit tests:** `npm test` gives 146/146 pass. That includes:
  - the run reducers, and the SSE parser on every character split and on byte splits with multibyte text;
  - resume decisions and ring replay;
  - run-client reconnect and dedupe;
  - browser-frames letterbox mapping and the newest-frame renderer.
- **Type check:** `npx tsc --noEmit` is clean.
- **Build:** `npm run build` succeeds.
- **Browser service tests:** `cd browser-service && npm test` passes all 15 tests (11 transport against real Chromium plus a fixture, 4 frame-delivery unit tests). The transport file passed 3 consecutive runs after the mode-switch fix. The tests cover:
  - bad, expired or missing token → 401;
  - frames and frame-meta;
  - not_in_control; invalid NaN/null/out-of-range/unknown-key input;
  - tap and type reaching the real DOM in order, acked;
  - 409 for agent steps during control;
  - a 200-scroll burst ending bounded with only `busy` errors;
  - release; control released on disconnect;
  - non-Amazon and metadata URLs blocked;
  - DELETE ends viewers.
- **Journey** (`scratchpad/e2e/journey.cjs`, 390×844 touch, DPR 3): **26/26 pass**. That covers 202 before the model; text while active; required take-over full screen; a tap changes the remote page; accepted resume; the same run continues; the draft is kept; the model sees the page after the shopper; no duplicate bubbles with stable ids; late resume → 409; refresh while paused re-opens the same step; a delayed ack doesn't hide a newer pause; wrong step → 409 stale_step with current; a double-tapped resume gives one accepted and one duplicate; cancel during a wait stops the run with no ghost and a late resume → 409; offline 2.5 s then the reply completes with no duplicated text; another shopper gets 404 on every run route, the chat and the browser token; a cross-origin create → 403.
- **Process loss** (`process-loss.cjs`): kill the storefront while waiting, restart, and the run reads `interrupted` with the error "Neon restarted before finishing. Tap retry.", the pending step cleared, and the user message kept with `failed: true`. The log shows "[runs] marked 1 unfinished run(s) interrupted".
- **Mobile and accessibility** (`mobile.cjs`, reduced motion on):
  - the dialog has role=dialog, aria-modal=true and aria-labelledby set to the instruction text, and focus moves to it;
  - the Done button is labelled "Done — continue" and is fully on screen in portrait (y 786–834 of 844) and landscape (y 332–380 of 390);
  - the canvas has an aria-label stating it's a remote screen;
  - there's a polite live region;
  - the body is locked while expanded and unlocked after;
  - focus returns to the card's button, not the composer (no keyboard pop on touch);
  - no animations under reduced motion;
  - the inline card is 362×279 after hand back.

## Measured responsiveness (fake model, loopback; not production numbers)
| measure | result |
|---|---|
| POST /runs → 202 | 66–94 ms |
| send → first assistant text on screen | 158–220 ms (the fake model streams at once; real first-token latency is Anthropic's) |
| take-over shown → first frame on the full-screen canvas | ~10 ms (socket already open inline) |
| tap → canvas changes | 125–181 ms |
| tap → server ack | ~275 ms (includes the 250 ms focus probe) |
| reload while paused → take-over open again | 63–135 ms |
| back online after 2.5 s offline → reply complete | 4.4 s (includes the rest of the slow stream) |

## Bugs found and fixed by the tests
- **Null coordinates were accepted:** `{x:null}` became 0 and tapped the corner. Coordinates must now be numbers.
- **The slow-observer test measured kernel buffers,** not the server queue. Delivery moved to `frames.mjs` with deterministic unit tests.
- **The Dockerfile copied only `server.mjs`.** It now copies `frames.mjs` too.
- **Phone↔desktop switches reloaded the page** (Puppeteer `setViewport` reloads on mobile/touch changes), throwing away the shopper's work. Both directions now use direct emulation calls.
- **Two cards opened on a pending step after a refresh:** an older reply showed the same browser. Pending steps are now scoped to the live reply's card.
- **The landscape full-screen canvas was cropped** (percentage height in a grid). It is now absolutely positioned with object-fit: contain.
- **Banner copy said "Tap Take over"** while the browser was already open. It now says "…then tap Done."
