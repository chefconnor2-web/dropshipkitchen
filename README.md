# Tetherless — off-grid power store on live CJ data

A branded off-grid power storefront built on **real products from CJdropshipping's official API V2**.
No mock catalog and no hand-entered products: everything the store sells was imported from CJ by PID,
and every storefront variant is mapped to one exact CJ variant (VID).

```
CJ product ─▶ CJ API V2 ─▶ our supplier record ─▶ our storefront product ─▶ customer picks a variant
                                                                             │
             order item keeps an immutable snapshot of PID / VID / SKU / price / stock ◀─┘
```

**What this proof doesn't do:** it never places or pays for a CJ order. `SUPPLIER_MODE=mock` is the
only mode implemented, Stripe accepts **test keys only**, and "Approve & Fulfill" records a mock supplier
reference plus a preview of the CJ order payload that would be sent.

## Setup

```bash
cp .env.example .env          # add CJ_API_KEY, STRIPE_SECRET_KEY (sk_test_…), ADMIN_PASSWORD
npm install
npx prisma db push            # creates the SQLite DB
npm run cj:check -- tweezers  # optional: confirm live CJ access from the command line
npm run seed:cj -- --publish  # optional: import ~10 real chef-supply products from CJ
npm run dev                   # http://localhost:3000/shop  ·  http://localhost:3000/admin
```

## Deploy (Fly.io, test mode)

The repo ships a `Dockerfile` and `fly.toml`. The SQLite database lives on a Fly volume mounted at `/data`.
On boot `scripts/start.sh` creates the schema and, when `CJ_API_KEY` is set and the catalog version in the
script differs from `/data/catalog-version`, imports the CJ catalog in the background (log: `/data/seed.log`)
and unpublishes the previous one. Bump `CATALOG` in the script after changing the seed targets.

```bash
fly launch --no-deploy --copy-config      # or create the app from the Fly dashboard; `app` in fly.toml must match
fly volumes create data --size 1
fly secrets set CJ_API_KEY=… STRIPE_SECRET_KEY=sk_test_… ADMIN_PASSWORD=…   # SITE_URL is set in fly.toml
fly deploy
```

Then add a Stripe test webhook for `https://<app>.fly.dev/api/stripe/webhook` and run
`fly secrets set STRIPE_WEBHOOK_SECRET=whsec_…`. Pay with Stripe's test card `4242 4242 4242 4242`.

Keep one machine: SQLite lives on a single volume, so don't scale this app past one instance.

## Fulfilling orders with CJ

`SUPPLIER_MODE` decides what the admin order page can do:

| Mode | What approving an order can do |
|---|---|
| `mock` (default) | Record a mock supplier reference. Nothing is sent to CJ. |
| `sandbox` | Also place CJ **sandbox** orders: simulated payment, nothing charged or shipped. |
| `live` | Also place **real** CJ orders, shipped to the customer and paid from your CJ balance. |

**Which warehouse ships it.** Shipping quotes try the usual warehouse first (CJ's US warehouse for a US
address it fully stocks, else China), then every other CJ warehouse that stocks the whole cart. When no single
warehouse works, the order is split into parcels that may ship from different warehouses (a battery CJ won't fly
from China can go by ground from the US while the rest ships from China). If a product can't ship to the
address from anywhere, the cart and checkout name it and the shopper can remove it. The assistant checks this
before recommending or adding a product. The warehouse quoted at checkout is stored on the order (`cjFromCountry`,
and per parcel in `parcelPlanJson`) and the CJ order ships from there.

**Showing shipping instantly.** Every CJ quote is remembered in the `ShippingQuote` table. Pages show a
remembered price at once and refresh it in the background when it's over 30 minutes old (checkout always
charges a fresh one). For a cart nobody has quoted yet, the cart and product page show a labelled estimate
from earlier quotes to that country by weight, then CJ's live price. Adding to the cart starts the cart's quote
in the background. On a shopper's first visit the middleware guesses their country and postcode from their IP
address (default service: ipwho.is; set `GEOIP_URL` to another URL with `{ip}`, or to an empty value to switch
this off). Shoppers can change the destination on any product page or in the cart.

On an order awaiting approval: **Get CJ shipping quote** (live freight options for the exact VIDs and address),
pick a method, then **Place sandbox test order**, or tick the confirmation and **Place real order & pay from CJ
balance**. The flow is CJ's own: `createOrderV3` (create only) → `confirmOrder` → `payBalance` (sandbox:
`sandbox/simulatePay`). An order can only be placed once; if payment fails the order stays created and
**Retry payment** pays it. **Refresh CJ status** pulls CJ's status and tracking number.

## Personalized (print-on-demand) products

Shoppers can put their own photo or text on CJ print-on-demand products. You approve each order, and the
CJ payment, after the customer has paid, exactly like any other order.

1. **Set up a product** (`/admin/products/[id]` → *Personalization*): switch it on, enter the CJ POD version
   and print area name from your CJ POD template, choose photo and/or text, the print file size, and where the
   print sits on the main photo (for the shopper's mock-up). Only CJ POD products can be printed; the panel
   shows any POD-related fields CJ's product data has.
2. **Shoppers design it** on the product page, or in the chat (tapping Add on the product's card opens the
   designer, with photos they sent the assistant one tap away). They see a live mock-up, drag and zoom the photo,
   confirm the design, and add it. Each design is its own cart line. The assistant's
   `show_personalized_products` tool shows these products when someone asks for something custom.
3. **The design is stored** with the line (`Personalization`): the print file (at your print size) and the
   mock-up, public at `/pod/<id>/art` and `/pod/<id>/preview` so CJ can download them (unguessable ids).
4. **You review it** on the order page: mock-up, print file and the exact `podProperties` CJ will get.
5. **On approval** the CJ order line carries `podProperties`: POD 2.0
   `[{"areaName":…,"links":["…/art"],"type":"1"}]`, POD 3.0 `[{"links":["…/art"],"effectImgs":["…/preview"]}]`.

`SITE_URL` must be the store's public https address, since that is where CJ downloads the artwork. Orders
with personalized items can't ship as split parcels yet, and personalized products never go in mystery boxes.
Test with a CJ **sandbox** order first: CJ documents `podProperties` on `createOrderV2`, and this store
places orders with `createOrderV3`.

## Plans: Full, Lite and Free

- **Full** (default **$30/month + the box's shipping**, set in `/admin/members`): the shopping assistant with
  **2× Lite's usage**, and a **surplus mystery box every month** from the box the subscriber picks on `/boxes`. Each
  paid monthly invoice becomes a box order waiting for your approval like any other. Shipping is quoted at signup and
  billed every month with the price. Subscriptions started before monthly boxes keep their one welcome box.
- **Lite** ($5/month): just the assistant (below).
- **Free**: search the catalog and shop it yourself, plus a few free assistant messages to try it.

Subscribers manage their card or cancel in Stripe's billing portal from `/account`.

- **Box margin.** Boxes are priced and drawn under the plan: each month's box products may cost at most
  price × (1 − margin) (default 86%: **$4.20 on $30**), and every box is worth at least the price at list prices.
  The AI box builder picks pool items within that. `/admin/members` shows each box's share of draws that fit; a box
  that can't fit shows as sold out.
- **Lite plan.** $5/month, AI only, no box (`/plans`; edit in `/admin/members`). Its margin (default 10%) is
  kept after Stripe's fee: at $5 that leaves $4.05 of AI per subscriber per 30 days, and each Lite subscriber is cut
  off once their measured AI cost reaches it, so Lite never loses money. Every message's real cost is recorded
  (`AiUsage.costMicros`, from the API's token counts at Anthropic's prices in `lib/ai-cost.ts`), and Lite's "messages a
  month" is the budget divided by the average measured cost. Full gets twice Lite's budget, capped the same way.
  Someone on both plans gets the full plan's allowance. Customers never see message counts.
- **Free trial.** People without a subscription get **3 free AI messages** (editable).
- **AI limits.** Subscribers' limits come from their plan's AI budget (Lite, and 2× on Full). You can set anyone's
  limit by hand in `/admin/members`.
- **Webhook.** Add a Stripe webhook for `checkout.session.completed`, `invoice.paid`,
  `customer.subscription.updated` and `customer.subscription.deleted`, and set `STRIPE_WEBHOOK_SECRET`. Without it,
  they're picked up when `/admin/members` syncs (every 15 minutes while it's open, or **Sync with Stripe**).
- **Accounts.** Shoppers sign in at `/account` with a 6-digit code emailed through Resend (`RESEND_API_KEY`;
  set `EMAIL_FROM` on a domain verified in Resend so codes reach everyone, not just your own inbox). Codes expire
  in 10 minutes, stop working after 5 wrong guesses, and are rate-limited per email and per network address; only
  an HMAC of each code is stored. Sessions are kept in the database (the cookie is a random token, stored hashed),
  so **Sign out** really ends them and **Sign out on all devices** ends them all. Subscribing requires signing in
  first, and the subscription is tied to that account, not to whatever email is typed at Stripe.
- **Tenancy.** Chats, chat photos and carts belong to the signed-in account (and follow it to any device), or to
  the browser while signed out. Signing in moves the browser's chats and cart into the account; once a chat or
  cart has an owner it only opens for that customer, whatever cookies a browser holds. Signing out gives the
  browser a fresh anonymous identity, so the next person on a shared computer sees nothing.
- **Billing portal.** Turn on Stripe's customer portal (Settings → Billing → Customer portal).

## Where things are

| Path | What it is |
|---|---|
| `/admin/suppliers/cj` | CJ connection status (Connected / Not Connected, with the last call and CJ `requestId`), live search via Product List V2, **View product**, **Import product** |
| `/admin/suppliers/cj/products/[pid]` | Live `product/query` view: every variant with VID, variant SKU, price, weight, dimensions; optional live stock per VID; raw CJ JSON |
| `/admin/products/[id]` | Our storefront data (title, description, internal SKU, price, categories, SEO, images, publish) next to the CJ supplier data. Variant table shows our variant → CJ VID / SKU / price / inventory / margin |
| `/shop`, `/products/[slug]` | Customer storefront: our brand, names, prices, photos, real variants, In Stock / Low Stock / Unavailable |
| `/cart` → Stripe Checkout (test) | Checkout revalidates stale stock by VID, then creates the order and its supplier snapshot |
| `/admin/orders/[id]` | Customer purchase vs. **Supplier mapping** (PID, VID, SKU, price and stock at order vs. now, estimated cost and gross profit), **REFRESH CJ DATA**, **APPROVE & FULFILL** (mock), **DECLINE & REFUND** (Stripe test refund) |
| `/admin/integration-proof` | Product → internal variant → SupplierOffer → live CJ data → what the customer sees, with **REFRESH LIVE DATA** and the "Last verified from CJ" time |
| `/admin` | Log of every HTTP call made to CJ (endpoint, HTTP status, CJ code, CJ `requestId`, timing) |

## CJ API usage

Base `https://developers.cjdropshipping.com/api2.0/v1`, header `CJ-Access-Token`.

| Purpose | Endpoint |
|---|---|
| Auth (token is stored and reused; CJ rate-limits token requests) | `POST /authentication/getAccessToken` `{apiKey}`, `POST /authentication/refreshAccessToken` |
| Search | `GET /product/listV2?keyWord=&page=&size=` |
| Product + variants | `GET /product/query?pid=` (falls back to `GET /product/variant/query?pid=`) |
| Current variant price | `GET /product/variant/queryByVid?vid=` |
| Inventory by exact VID | `GET /product/stock/queryByVid?vid=` |

CJ calls start at least `CJ_MIN_INTERVAL_MS` apart to respect QPS limits, with up to `CJ_MAX_CONCURRENT` (default 3;
set 1 for strictly one at a time) in flight, so a slow reply doesn't delay the next call. Freight answers are
remembered for 30 minutes, so changing a quantity re-asks CJ only about what changed. The full raw CJ
response is stored with each supplier product and variant, and the admin search and view pages show the
unmodified JSON, so field mappings can be checked against what CJ actually returned.

## Data model (see `prisma/schema.prisma`)

- **Supplier data:** `CjSupplierProduct` (PID, product SKU, name, description, images, raw JSON) and
  `CjSupplierVariant` (VID, variant SKU, name/key, image, supplier price, weight, dimensions,
  inventory total, per-warehouse inventory, timestamps).
- **Our storefront data:** `Product` (title, description, internal SKU, categories, SEO, status,
  delivery estimate), `ProductImage`, and `ProductVariant` (name, options, internal SKU, our price).
- **Bridge:** `SupplierOffer` links one `ProductVariant` to one CJ variant: supplier, PID, product SKU, VID, variant SKU.
- **Members:** `Customer` (also the shopper's account: `stripeCustomerId`, `aiLimitOverride`), `Subscription`
  (one Stripe subscription, with its welcome box), `SubscriptionPayment` (later paid months), `AiUsage` (one row per AI message), `LoginCode` (emailed sign-in codes, hashed), `CustomerSession` (signed-in browsers, token hashed);
  box orders carry `Order.stripeInvoiceId` / `subscriptionId`.
- **Personalization:** `Product.personalizeJson` (the POD set-up) and `Personalization` (one shopper design:
  print file, mock-up, text), linked from `CartItem` and `OrderItem.personalizationId`.
- **Orders:** each `OrderItem` copies supplier, PID, VID, SKU, supplier price, and inventory at order time,
  plus our title, variant name and price, so history does not depend on the live catalog.
  `SupplierCheck` records every later live recheck.

Variant options come from CJ's own keys: product `productKeyEn` (e.g. `Color-Size`) split against each
variant's `variantKey` (e.g. `Black-30cm`). If they don't line up, the whole CJ key is used as a
single option rather than inventing values.

## Keeping CJ invisible to customers

- Storefront queries go through `lib/storefront.ts`, which returns only our fields and a stock *label*
  (not the unit count).
- Images are served from our own `/media/<id>` route, so supplier CDN URLs never reach the browser.
- Imported descriptions are converted to plain text, with lines mentioning CJ, dropshipping, or URLs removed. You then rewrite them.
- Stripe line items use our product and variant names only.

## Tests

`npm test` runs the unit tests for CJ payload parsing and normalisation. `npm run lint` type-checks.
