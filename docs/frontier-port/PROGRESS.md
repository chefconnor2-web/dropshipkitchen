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
