# Chit — project handoff

A complete orientation for a developer (human or agent) taking over this repository. It describes what
the app is, how it is built, where everything lives, how money and data flow through it, how it is
deployed, and what to watch out for. Everything here was checked against the code in this repo; where the
older `README.md` disagrees, this document is right and the README is stale (see
[§15 Known discrepancies](#15-known-discrepancies-and-gotchas)).

All paths are relative to the repo root (`/home/user/dropshipkitchen` in the cloud environment).

---

## 1. What this is, in one paragraph

Chit is a Next.js storefront with an AI shopping-and-travel assistant called **Neon**. It started life as
an off-grid-power dropshipping store built on **live CJdropshipping data** (no mock catalog — every product
is imported from CJ by PID and every storefront variant maps to one exact CJ variant/VID), and it grew a
second half: Neon, who can search the catalog, build carts, book flights, hotels and rental cars, read
links, send email, and act for a customer through an **MCP connector** installed in Claude or ChatGPT. The
same codebase also contains an admin back-office for fulfilling CJ orders, a subscription/plan system with
AI usage budgets, and a company-travel proof of concept.

The store name is configurable (`STORE_NAME`, default **"Chit"**). Older artifacts call it "Tetherless"
and "Chef Supply" — see §15.

---

## 2. Tech stack and top-level layout

- **Framework:** Next.js 15 (App Router, React 19), TypeScript.
- **ORM/DB:** Prisma 6 over **SQLite** (not Postgres). One file DB on a mounted volume.
- **Payments:** Stripe (test mode only — see §6).
- **AI:** Anthropic SDK (`@anthropic-ai/sdk`). Planner + scout model architecture.
- **MCP:** `@modelcontextprotocol/sdk` + `ext-apps` for the connector and its interactive cards.
- **External travel/commerce APIs:** CJdropshipping (products + fulfilment), Duffel (flights), LiteAPI
  (hotels), Discover Cars (rental cars, via the live browser), Amazon (via the live browser), Resend
  (email), Google (Gmail send-only).
- **A second deployable service:** `browser-service/` — a standalone Node + Puppeteer service that runs
  live Chrome sessions Neon can drive and the shopper can watch/take over.

Top-level folders:

| Path | What |
|---|---|
| `app/` | Next.js routes (storefront, admin, account, chat, api, mcp, oauth, media) |
| `lib/` | All business logic (assistant, connectors, CJ, Stripe, pricing, membership, sessions…) |
| `components/` | React UI, notably `components/chat/` |
| `prisma/schema.prisma` | The whole data model |
| `browser-service/` | The separate live-browser microservice |
| `scripts/` | `seed-cj`, `cj-check`, `cj-source`, `reprice`, `start.sh` |
| `tests/` | `tsx --test` unit tests |
| `docs/` | `ROADMAP.md`, `frontier-port/` (CONTRACTS, PLAN, PROGRESS), this file |

---

## 3. Running it locally

```bash
cp .env.example .env     # set CJ_API_KEY, STRIPE_SECRET_KEY (sk_test_…), ANTHROPIC_API_KEY, ADMIN_PASSWORD
npm install
npx prisma db push       # create the SQLite schema (no migrations exist; see §14)
npm run dev              # http://localhost:3000
npm test                 # tsx --test tests/*.test.ts
npm run lint             # tsc --noEmit
```

Useful scripts: `npm run cj:check -- <query>` (confirm live CJ access), `npm run seed:cj -- --publish`
(import real CJ products), `npm run reprice` (re-apply the pricing rule to all variants).

---

## 4. The data model (`prisma/schema.prisma`)

Provider is **sqlite**, reading `DATABASE_URL` (in the container:
`file:/data/store.db?socket_timeout=30&connection_limit=1`). There are **no migrations** — the schema is
applied with `prisma db push`. The model has two layers: raw **supplier** data (CJ responses, kept as
returned) and the store's own **storefront** data, linked by `SupplierOffer`.

**Catalog & supplier**
- `CjSupplierProduct` / `CjSupplierVariant` — raw CJ products and variants (PID/VID, cost, weight, stock
  JSON, raw response).
- `Product` / `ProductImage` / `ProductVariant` — storefront catalog; variant has `priceCents`; a product
  may carry POD settings in `personalizeJson`.
- `SupplierOffer` — links one storefront variant to exactly one CJ VID.
- `CjApiCall` — audit log of every CJ HTTP call.

**Cart, orders, fulfilment**
- `Cart` / `CartItem` / `CartBox` — the cart; `CartBox` is a mystery box whose items are drawn when added.
- `Personalization` — a shopper's POD design (art + preview bytes, UUID id).
- `Order` / `OrderItem` / `TrackingEvent` / `OrderParcel` / `SupplierCheck` — orders and fulfilment.
  `OrderItem` is an immutable snapshot of what was bought (PID/VID/SKU/price). `OrderParcel` is one CJ
  order within a split shipment. `SupplierCheck` records each re-check against CJ.
- `ShipCheck` — cached "does this PID ship to this country" answer (price + warehouse origins, ~1 week).
- `ShippingQuote` — remembered CJ shipping quotes, also used for weight-based estimates.
- `Dispute` — Stripe chargebacks (evidence, blocking, owner alerts).

**Customers, plans, auth**
- `Customer` — one row per email; Stripe customer id, admin AI-limit override, notes, tags.
- `Subscription` / `SubscriptionPayment` — Stripe plan subscriptions ("full"/"lite", optional monthly box).
- `AiUsage` — one row per AI message with its cost in micro-dollars (basis of the AI allowance).
- `LoginCode` — emailed 6-digit sign-in codes (HMAC stored, attempts counted). `LoginToken` — retired
  magic links. `CustomerSession` — signed-in browsers (SHA-256 of the cookie token).
- `Setting` — key/value config (`ai.limits`, `subscription.plan`, `subscription.lite`, session secret…).

**Assistant**
- `AssistantChat` / `AssistantRun` / `AssistantImage` — chat transcripts, durable background runs, uploaded
  photos. See §8.

**Travel & extras**
- `FlightBooking` / `SharedTrip` — Duffel bookings and shareable trip links.
- `HotelOffer` / `HotelBooking` — LiteAPI offer snapshots and bookings.
- `TravellerProfile` — saved traveller details (encrypted).
- `Company` / `CompanyMember` / `CompanyInvite` / `Expense` — company-travel proof of concept.
- `Gift` — free branded items the merchant sends, claimed via link, fulfilled as a $0 order.
- `GmailConnection` — a shopper's send-only Gmail (refresh token encrypted).
- `MysteryBox` / `MysteryBoxPoolItem` — AI-designed boxes and their draw pool.
- `FreightRequest` — pallet/sea-freight quote requests. `WaitlistEntry` — "Link line" sign-ups.
- `EmailLog` — every rendered email and its Resend send status.
- `McpClient` / `McpAuthRequest` / `McpToken` / `McpCall` — MCP OAuth, plus audit and rate-limit log.

---

## 5. Routes (`app/`)

**Chat (`(chat)` group)** — `/` is the Neon chat (rendered in `layout.tsx` so it survives chat switches);
`/c/[id]` gives one chat its own URL.

**Connect (`(connect)` group)** — `/oauth/consent/[id]`: where an AI app (Claude/ChatGPT) asks a customer
for access; they sign in, then allow/deny.

**Storefront (`(store)` group)**
- Catalog: `/shop`, `/products/[slug]`, `/search`, `/search/item/[pid]`.
- Cart/checkout: `/cart`, `/checkout/success`, `/pay/[id]` (embedded Checkout session), `/subscribe/complete`.
- Orders: `/orders/[number]`, `/track`.
- Plans/boxes: `/plans`, `/boxes`, `/boxes/[slug]`.
- Specialty: `/picks` (vetted catalogue by sector), `/link` + `/runtime` (Starlink Mini adapter line and
  runtime calculator).
- Account: `/account` (emailed-code sign-in, AI allowance, billing portal), `/connect` (add Chit to
  Claude/ChatGPT; connected apps + activity).
- Company: `/company`, `/company/join`.
- Travel: `/flights/book/[offerId]`, `/flights/trip/[number]`, `/hotels/book/[offerId]`,
  `/hotels/stay/[number]`, `/trips/[slug]`.
- Other: `/gift/[token]`, `/refunds`, `/privacy`, `/terms` (the last two are marked drafts).

**Admin (`/admin`, HTTP Basic auth in `middleware.ts`; 503 if `ADMIN_PASSWORD` unset)** — dashboard;
`orders` + `orders/[id]` (approve, quote CJ, place & pay); `products` + `products/[id]`; `suppliers/cj` +
`suppliers/cj/products/[pid]`; `customers` (+ `[id]`, `export`); `members`, `boxes` (+ `[id]`, `build`,
`presets`); `flights`, `hotels`, `disputes`, `freight`; `gifts` (+ `bottles`), `emails` (+ `[id]`),
`waitlist` (+ export), `integration-proof`.

**API (`app/api`)** — `assistant/*` (transcript; `runs` POST→202 then SSE events; cancel/resume/
check-payment; chat list/rename/delete; image upload/view; add-to-cart; add-kit; live-browser view token);
`stripe/webhook`; `shipping` + `ship-check`; `personalize`; `profile`; `google/connect|callback|disconnect`;
`trips` + `trips/[slug]/offers`; `company/expenses.csv`.

**MCP & OAuth** — `/mcp` (Streamable HTTP MCP server, stateless, Bearer token; built in `lib/mcp-server.ts`,
`lib/mcp-tools-more.ts`, `lib/mcp-auth.ts`); `/oauth/authorize|register|token|revoke`;
`/.well-known/oauth-authorization-server`; `/.well-known/oauth-protected-resource/[[...path]]`.

**Media** — `/media/[id]`, `/media/v/[id]`, `/media/p/[pid]`, `/media/s/[pid]` (hide supplier CDN URLs);
`/pod/[id]/[file]` (public POD art/preview so CJ can download).

---

## 6. Payments (Stripe)

- **Test-mode guard (`lib/stripe.ts`, `lib/config.ts`):** `stripeKeyProblem()` rejects any key that is not
  `sk_test_`/`rk_test_`. **Live keys are refused by design** — as written, the app cannot take real money.
  `STRIPE_API_HOST` can point the client at a local fake.
- **Catalog checkout (`app/(store)/actions.ts`):** `mode: "payment"`, USD, store's own names/prices, one
  fixed shipping rate from the CJ quote, address restricted to the quoted country, `metadata.orderId`.
- **Flights/hotels (`lib/flight-booking.ts`, `lib/hotel-booking.ts`):** both use `checkoutWithFlexPay`
  (`lib/flex-pay.ts`). Klarna/Affirm/Afterpay are offered only when the margin covers an assumed 6.5% + 30¢
  fee plus a $5 reserve and the currency supports them (`FLEX_PAY=off` disables; `FLEX_PAY_COST_PCT` tunes).
  Falls back to card+Klarna, then card-only, if Stripe refuses a method. Checkout expiry follows offer
  validity. Flights request 3DS by default (`FLIGHT_3DS`). The Duffel/LiteAPI booking is made **only after
  payment**, under a status lock so it happens once.
- **Subscriptions (`lib/subscriptions.ts`):** `mode: "subscription"`, inline prices —
  `startBoxSubscription` (Full + monthly box shipping), `startFullSubscription`, `startLiteSubscription`;
  `billingPortalUrl` opens Stripe's portal.
- **Webhook (`app/api/stripe/webhook/route.ts`, `STRIPE_WEBHOOK_SECRET`; treated as optional because
  success pages also confirm):** `checkout.session.completed` / `async_payment_succeeded` route four ways —
  subscription → `completeSubscriptionCheckout`; `flightBookingId` → `completeFlightBooking`;
  `hotelBookingId` → `completeHotelBooking`; else → `markOrderPaidFromSession`. `invoice.paid` →
  `orderForInvoice` (one box order per invoice). `charge.dispute.*` → `recordDispute` + `processDisputes`.
  `customer.subscription.updated|deleted` → `updateSubscriptionFromStripe`.
- **Background jobs (`instrumentation.ts`):** dispute sync (~15 min), carrier-tracking poll, recovery of
  interrupted assistant runs.

---

## 7. Pricing and profit rules

- **`lib/money.ts`:** store price = `max(cost × 2.2, cost + $10)` rounded up to the next `.99`
  (`MARKUP = 1.2`, `MIN_PROFIT_CENTS = 1000`). `lib/pricing.ts` `applyPricingRule` reprices variants from
  cached CJ cost; `scripts/reprice.ts` runs on every boot. `tieredMarkup`/`suggestRetailCents` are older
  suggestion helpers.
- **`lib/volume.ts` `priceOrder`:** bulk discounts off unless `BULK_DISCOUNTS=on`. When on (orders ≥ $100
  cost or ≥ 5 units), markup steps down with cost (25% <$500, 20% ≥$500, 15% ≥$2k, 12% ≥$5k); 25+ units get
  −1%, 100+ units −2%, floor 10%; whole order must still clear $10 profit and never exceed list.
  **Owner pricing:** owners pay CJ cost lifted by the worst-case card fee (`noLossCents`), capped at list.
- **`lib/margin.ts`:** `noLossCents = (cost + 30¢ + extra) / (1 − 4.4%)` (`CARD_WORST_PCT`,
  `CARD_FIXED_CENTS`); plus `worstCardFeeCents`, `checkoutExpiry`, `flight3ds`.
- **Travel fees:** flights (`lib/flights.ts`) $15 + 3%, floored at `noLossCents` incl. Duffel's $3 fee,
  rounded up to a whole unit; hotels (`lib/hotels.ts`) $5 + 3% plus a 3% FX allowance when currency ≠
  `LITEAPI_BILLING_CURRENCY`.
- **`lib/fulfillment.ts` `guardProfit`:** runs before a CJ order is created (estimated cost) and again
  before paying CJ (actual total). If `paid − worstCardFee − cjCost < $5` (`MIN_KEEP_CENTS`), it calls
  `refundForLoss` (full idempotent Stripe refund, order → `DECLINED_REFUNDED`, emails customer + alerts
  owner; any created CJ order left unpaid for manual cancel) and throws. Skipped for gifts, subscription
  box orders (they carry an invoice id), and owner emails.
- **`lib/membership.ts`:** `isOwnerEmail` checks `OWNER_EMAILS` + `EXTRA_OWNER_EMAILS`; `ownerPricing()`
  gives the signed-in owner (or the MCP customer being acted for) at-cost pricing and no AI limit.

**Guiding principle (stated by the owner, enforced in code): the store must never lose money, even on a
full refund or dispute.** `noLossCents`, `guardProfit`, and the 1.2 markup all exist to hold that line.

---

## 8. The assistant (Neon)

Two files do most of the work: `lib/assistant.ts` (one shopper turn) and `lib/runs.ts` (durable background
runs). The shared, foldable event/frame contract lives in `lib/run-shared.ts`, the browser client in
`lib/run-client.ts`, and the UI in `components/chat/Chat.tsx`.

**Turn shape (`lib/assistant.ts`).** A **planner** model breaks the request into parts and fans out cheap
**scout** agents (one per part) to search the CJ catalog; results stream to the chat as they arrive.
- Models: `ASSISTANT_MODEL` (planner, default `claude-sonnet-5-5`), `ASSISTANT_SCOUT_MODEL` (scouts +
  titles + emoji, default `claude-haiku-4-5`). `ASSISTANT_EFFORT` default `medium`;
  `ASSISTANT_MAX_ROUNDS` default 24.
- Caps: 3 rounds / 2 searches per scout; ≤8 parts, 5 scouts concurrent; ≤40 shopper turns per chat; ≤4
  images per message; trace ≤40 items / 6000 chars. `SHOW_AI_COST` (default on) attaches reply cost.
  `assistantConfigured()` = `ANTHROPIC_API_KEY` present. Web sourcing on when `SOURCING_WEB` (default on)
  and the planner is not Haiku.
- `systemPrompt()` covers the store specialty (`lib/curated`), battery/charger voltage matching, warehouse
  rules, POD + kit flow, the optional web-sourcing section, then each enabled connector's prompt text.
  `VOICE_NOTE` is appended in voice mode.
- Built-in planner tools: `find_products`, `get_product`, `add_to_cart`, `propose_kit`/`add_kit` (only
  pids already shown this chat, via `ctx.known`), `show_personalized_products`, `view_cart`. Plus connector
  tools, and when web sourcing is on, `show_suppliers` + Anthropic server tools `web_search_20260209` /
  `web_fetch_20260209` (caps `SOURCING_MAX_SEARCHES` 25, `SOURCING_MAX_FETCHES` 15).
- The main loop streams `client.beta.messages.stream` with `max_tokens` 32000, ephemeral cache, adaptive
  thinking for non-Haiku planners, and server-side fallback (`server-side-fallback-2026-07-01`). All tool
  calls in a round run in parallel. `pause_turn` → continue; `refusal` → canned line. Cost is computed from
  the model that actually answered (fallbacks can switch it), in micros (1¢ = 10,000µ), via `lib/ai-cost.ts`.
- Abort (shopper stops) still counts the in-flight round's usage, drops a dangling `tool_use`, and saves
  the partial text with `stopped: true`.

**Durable runs (`lib/runs.ts`).** One replica owns every run (single SQLite volume, `numReplicas: 1`).
State lives both in memory (`processSingleton("assistant-runs")`: abort controller, 2000-frame ring buffer,
subscribers, pending-step waiter) and in the `AssistantRun` row. Status: queued → running ⇄ waiting →
completed | failed | cancelled | interrupted. `ASSISTANT_MAX_ACTIVE_RUNS` default 12 (else 503);
`ASSISTANT_WAIT_MINUTES` default 15. Partial reply saved ≤ every 750 ms; finished runs linger 5 min in
memory. `acceptRun` dedupes `(chatId, clientRequestId)`, 409s a second active run in a chat, 503s over the
global cap, saves the shopper message immediately as `u_<runId>`. `recoverInterruptedRuns` (from
`instrumentation.ts`) marks orphaned active rows `interrupted` on boot.

**Take-over / `waitForShopper`.** A run can pause on a step only the shopper can do — kinds `captcha |
sign_in | checkout | choice | blocked | email`. It emits an `approval` event and `pending`/`waiting`
frames, carries an optional live-browser `{sessionId, cardId}`, and resolves `resumed` | `cancelled` |
`expired`. `resumeRun` uses the pure `decideResume` (only the exact pending step, pre-expiry) and does all
state changes before the first `await` so concurrent resumes can't both win. `step.until` (e.g. a detected
payment) auto-resumes.

**HTTP (`app/api/assistant/`).** `runs` POST does origin check, config check, `clientRequestId` validation,
doc cleaning, duplicate short-circuit, per-IP rate limit (`allowTurn`: 30/hr/IP), allowance check (402 with
plan offer), then `acceptRun` + `after(start)` → 202. `runs/[id]/events` is SSE with `?after=<seq>` and a
15 s ping. Ownership checked on every run route via `findOwnChat` (else 404).

---

## 9. Connectors (`lib/connectors/`)

Each connector exposes `enabled()`, `prompt(today)`, `tools`, and `run(tool, input, ctx)`. `ctx` carries
`progress`, `show` (same-id card replaces), `chatId`, `signal`, and `waitForShopper`; a tool result may
include `micros` (counts toward turn cost). Registry order in `lib/connectors/index.ts`:

| Connector | Enabled when | Tools / notes |
|---|---|---|
| duffel | `duffelConfigured` | `find_places`, `find_flights`, `get_flight` |
| liteapi | `liteapiConfigured` | `find_hotels` |
| discovercars | `discoverCarsConfigured` | `rental_car_*`; live browser; payment hand-over via `watchPayment`/`until` |
| amazon | `browserConfigured` | `amazon_*`, `browser_act`, `browser_hand_over` |
| stores | always | `store_cart` (builds cart links on Shopify/Woo/BigCommerce, Amazon cart links) |
| links | `browserConfigured` | `read_link` (opens a public link in a read-only browser, returns text + screenshots) |
| trips | always | `save_my_details`, `my_trips`, `trip_bookings`, `send_email` (pauses with an `email` approval) |
| company | always | `company_policy`, `set_work_trip`, `log_expense` |

**`read_link` behaviour (`lib/connectors/links.ts`):** opens the shared URL in the browser service's
read-only mode and returns page text + up to 3 screenshots. When a page answers with a bot/robot check
(`robotCheck`), it still returns whatever rendered, pulls the question out of a Google search URL when the
`q` value reads like a question, and instructs Neon to answer from a fresh `web_search` instead of
stopping. This is the current, deployed behaviour for blocked Google/share.google links.

---

## 10. The live-browser service (`browser-service/`)

A separate Node + Puppeteer service, deployed as its own Railway service with its own `railway.json`
(healthcheck `/health`). It runs one incognito Chrome context per chat that Neon drives and the shopper can
watch and take over (CDP screencast streamed to the live card; input relayed back). Key env:
`BROWSER_SERVICE_URL` (private network address the storefront calls), `BROWSER_PUBLIC_URL` (public https
for the live view), `BROWSER_SERVICE_SECRET` (shared secret on both services). The client is `lib/browser.ts`.

Navigation is **allowlisted**: `NAV_ALLOWED` currently permits Amazon and Discover Cars only; `POST /read`
(the `read_link` path) is separate and checks that the host resolves to a public address (`publicHost`,
with the `BROWSER_TEST_ALLOW` regex escape hatch for tests). Private/loopback/link-local addresses are
always refused (SSRF guard). Contracts are in `docs/frontier-port/CONTRACTS.md` (§3 ownership/tokens, §7
take-over, §8 browser service).

---

## 11. Membership, plans, AI allowance, auth

- **Plans (`lib/plan.ts`, stored in `Setting`):** Full default $30/mo, 86% box margin (box cost ≤
  price × (1 − margin)); the box variant adds a monthly box with shipping billed monthly. Lite default
  $5/mo, 10% margin → AI budget ≈ price × 0.9 − Stripe fee ≈ $4.05.
- **AI allowance (`lib/membership.ts`):** non-subscribers get 3 free messages ever (per browser and per
  account); subscribers get a 30-day AI **cost** budget (Lite's, 2× on Full), shown as a message count via
  average measured cost (60,000µ assumed until 10+ measured); `Customer.aiLimitOverride` overrides; owners
  effectively unlimited (1M). Allowance is checked **when a message is accepted**, and cost recorded after
  the run ends — so one long turn can overshoot (see §15).
- **Auth (`lib/session.ts`):** 6-digit email code via Resend (`lib/email.ts`); codes last 10 min, 5
  attempts, rate-limited per email + IP. Session = `cs_session` httpOnly cookie (random token; DB stores
  SHA-256 in `CustomerSession`), 90 days sliding. Other cookies: `cs_vid`, `cs_cart`, `cs_chat`. Admin =
  Basic auth (`ADMIN_PASSWORD`, optional `ADMIN_USER`). MCP = OAuth 2.1 + PKCE + dynamic registration;
  scopes `chit` and `chit:read`.
- **Tenancy:** chats/photos/carts belong to the signed-in account (follow it across devices) or to the
  browser while signed out; signing in migrates the browser's chats + cart into the account; signing out
  gives a fresh anonymous identity.

---

## 12. CJdropshipping integration

- **Files:** `lib/cj/client.ts` (token, product list/detail, variants, stock, sourcing,
  `freightCalculate`, `createOrderV3`, `confirmOrder`, `payBalance`/`payBalanceV2`, `sandboxSimulatePay`,
  `getOrderDetail`, `trackInfo`, `getBalance`); `lib/cj/lanes.ts` (in-process rate-limit queue,
  `CJ_MIN_INTERVAL_MS` 1100, `CJ_MAX_CONCURRENT` 3); `import.ts`, `normalize.ts`, `status.ts`, `types.ts`.
  Related: `fulfillment.ts`, `shipping.ts`, `parcels.ts`, `warehouses.ts`, `tracking.ts`, `inventory.ts`,
  `sourcing.ts`. Scripts: `seed-cj.ts`, `cj-check.ts`, `cj-source.ts`.
- **`SUPPLIER_MODE` (`lib/config.ts`, default `mock`):** `mock` records `MOCK-CJ-<number>` only; `sandbox`
  places CJ sandbox orders (simulated pay); `live` places real orders paid from the CJ balance.
- **Order flow:** Stripe payment → `AWAITING_MERCHANT_APPROVAL` (+ emails) → admin "Get CJ shipping quote"
  (`quoteShipping`) → `placeCjOrder` (`guardProfit`, atomic lock to `PLACING_SUPPLIER_ORDER`, `createOrderV3`)
  → `payCjOrder` (`guardProfit` on CJ total, `confirmOrder`, `payBalance`/`simulatePay`) →
  `refreshCjOrder` (status + tracking). Split orders become one CJ order per `OrderParcel`.
- **Shipping:** warehouse rules (US→US, CA→CA, CN→anywhere); try usual warehouse, then any holding the
  whole cart, then split; cache in `ShippingQuote`, refresh after 30 min, always fresh at checkout;
  weight-based estimate for uncached carts; IP→country guess in middleware (`GEOIP_URL`, default ipwho.is).

---

## 13. Deployment (Railway)

- **`Dockerfile`:** `node:22-slim` + openssl, `npm ci`, `npm run build` (`prisma generate && next build`)
  against a throwaway SQLite DB; sets `DATABASE_URL=file:/data/store.db…`; runs `sh scripts/start.sh` on
  port 3000. It creates `/data` even with no volume, but **without a mounted volume all data is lost on
  every redeploy** — Railway must mount a volume at `/data`.
- **`railway.json`:** Dockerfile builder, healthcheck `/shop` (120 s), restart-on-failure (max 5).
- **`scripts/start.sh`:** (1) `npx prisma db push --skip-generate` applies the schema every boot; (2)
  `npm run reprice` (non-fatal); (3) if `CJ_API_KEY` set and `/data/catalog-version` ≠ `CATALOG` (`tools-1`),
  import the CJ catalog in the background (`seed:cj --publish --replace --limit 12`, log `/data/seed.log`);
  (4) `next start`.
- **Two services:** the storefront and `browser-service/` are separate Railway services in the same
  project. Both auto-deploy from the `preview` branch (that is the working branch in this project).
- **Single instance only:** SQLite on one volume means the app must stay at one replica.
- The repo still contains `fly.toml` (for a preview app `tetherless-preview`); Fly is **not** the current
  production target. Treat `fly.toml` and the Fly sections of `README.md` as legacy — see §15.

---

## 14. Tests, contracts, conventions

- **Tests:** `npm test` runs `tsx --test tests/*.test.ts` (214 passing as of this handoff). Notables:
  `tests/runs.test.ts` (`applyEvent`/`applyFrame`/`SseParser`/`decideResume`/`replayFrom`), `run-client`,
  `sourcing`, `store-carts`, `links`. The browser service has its own tests under `browser-service/test/`.
- **Contracts:** `docs/frontier-port/CONTRACTS.md` is the source of truth for the run lifecycle, SSE frames,
  take-over, and the browser service. Read it before touching `lib/runs.ts` or the browser flow.
- **Workflow conventions in this project:** work on the `preview` branch; open a **draft PR** per change;
  keep `npm test` + `npm run lint` green before pushing; merge and let Railway auto-deploy. Do not put any
  AI model identifier into commits, PR text, or code. Stripe stays in test mode — never add live keys or
  create live charges/refunds without the owner's explicit go-ahead.
- **No DB migrations exist.** Schema changes are applied by `prisma db push`. A destructive column change on
  a live SQLite volume needs care (back up `/data/store.db` first).

---

## 15. Known discrepancies and gotchas

- **`README.md` is stale.** It documents Fly deploys and says "only `mock` mode is implemented" (false —
  `sandbox` and `live` exist). It is right that Stripe is test-keys-only. Prefer this document.
- **Store name varies by artifact:** `STORE_NAME` default "Chit"; `fly.toml` says "Tetherless"; the schema
  header says "Chef Supply". Set `STORE_NAME` to whatever the live brand should be.
- **Allowance can overshoot** — checked at accept, charged after the run; one long turn may exceed the
  remaining budget by a little.
- **MCP `ask_neon` skips the per-IP limit** — only the HTTP route calls `allowTurn`. MCP calls are bounded
  by the OAuth token's own rate log (`McpCall`) and the allowance instead.
- **Restarts lose in-progress runs** — a mid-tool-loop run can't resume; the user retries. This is inherent
  to the single-replica + SQLite design.
- **Trace cap differs by side** — 40 items saved on the reply vs 60 in the live `PartialEntry`.
- **Live browser is allowlisted to Amazon + Discover Cars** for navigation; `read_link` is a separate
  public-host-checked path. Google/share.google links frequently hit a bot check from the data-centre IP;
  the deployed behaviour is to extract the question and answer from a fresh web search, or let the shopper
  paste/screenshot the page.

---

## 16. Where to start as the new owner

1. Get the app running locally (§3), then read `docs/frontier-port/CONTRACTS.md`.
2. Skim `lib/assistant.ts` and `lib/runs.ts` — they are the heart of the product.
3. Confirm the Railway setup: two services, a `/data` volume on the storefront, the env vars in §6/§8/§11,
   and the `preview` auto-deploy.
4. Check `docs/ROADMAP.md` and `docs/frontier-port/PROGRESS.md` for what was in flight.
