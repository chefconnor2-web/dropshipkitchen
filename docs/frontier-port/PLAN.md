# Frontier port: task board

The destination is Chit (Frontier): Next.js 15 storefront plus `browser-service/` on Railway (`tetherless` / `preview`, 1 replica each). The source is `workflow-agent-cart` @ `78b5259`, read-only. Contracts are in `CONTRACTS.md`, and evidence is in `PROGRESS.md`.

Statuses: TODO, READY, IN_PROGRESS, BLOCKED, DONE. DONE requires evidence.

| ID | Task | Deps | Owner (files) | Status |
|---|---|---|---|---|
| T01 | Inspect both projects, baseline | — | coordinator | DONE |
| T02 | Shared contracts + ownership model | T01 | coordinator: `lib/run-shared.ts`, `components/chat/run-context.ts`, `prisma/schema.prisma`, `lib/flights-shared.ts` (BrowserCard), CONTRACTS.md | DONE |
| T03 | Authenticated persistence + run APIs | T02 | backend agent: `lib/runs.ts`, `app/api/assistant/runs/**`, `app/api/assistant/route.ts`, `instrumentation.ts` | DONE |
| T04 | Assistant + progress streaming (signal, waiter, cancel-save, failed entries) | T03 | backend agent: `lib/assistant.ts`, `lib/connectors/types.ts` | DONE |
| T05 | Browser worker + transport (backpressure, input queue, tokens, release, cleanup) | T03 | browser agent: `browser-service/**`, `lib/browser.ts`, `app/api/assistant/browser/route.ts`, `lib/connectors/amazon.ts` | DONE |
| T06 | Frontier browser presentation (canvas renderer, mapping, states, expansion) | T02 (final: T05) | browser-UI agent: `components/chat/BrowserView.tsx`, `components/chat/browser-frames.ts`, `app/globals.css` (`.cx-browser*` only) | DONE |
| T07 | Chat-first browser + required takeover integration (run client) | T04, T05, T06 | chat agent: `components/chat/Chat.tsx`, `components/chat/ui.tsx`, `lib/run-client.ts` | DONE |
| T08 | Harden recovery, isolation, limits | T07 | verify agents | DONE |
| T09 | Mobile styling + accessibility verification | T07 | verify agents | DONE |
| T10 | Integrated verification, review, delivery | T08, T09 | coordinator + review agents | IN_PROGRESS |

## Acceptance checks

**T03**
- History survives reload.
- Owner gets 200; non-owner and logged-out get 404.
- Create acks before the model runs.
- Repeating a clientRequestId returns the same run.

**T04**
- Text deltas reach the client before `done`.
- The SSE parser handles any chunk split (unit test).
- Refetch does not duplicate.
- Failures are visible, and the user message is kept with `failed`.

**T05**
- Input changes the real page (fixture page via Puppeteer).
- The slow-observer queue stays bounded.
- A bad token or no control gives 401 or an error.
- `DELETE` and crash free the session.

**T06**
- Frontier styles are used.
- Expansion keeps the same socket.
- No React state change per frame.
- Draft and scroll state persist.

**T07**
- Normal → takeover → accepted resume → chat continues.
- A rejected resume, a duplicate resume, and a newer pause arriving during a delayed acknowledgement are all handled.

**T08**
- Reconnect works, including refresh while paused.
- No cross-account data.
- Cancelling during a wait stops the run.
- Process-loss marks the run interrupted.

**T09**
- Works on a 390×844 phone viewport.
- The keyboard bar stays reachable.
- Focus is restored.
- Reduced motion is respected.
- Labels are present.

**T10**
- `npm run lint` (tsc), `npm test` and `npm run build` pass.
- The journey test passes.
- Measurements are recorded.
