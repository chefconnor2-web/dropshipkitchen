# Chef Supply — live CJ product portal (proof)

A branded chef-supply storefront built on **real products from CJdropshipping's official API V2**.
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

CJ calls are serialised with a minimum gap (`CJ_MIN_INTERVAL_MS`) to respect QPS limits. The full raw CJ
response is stored with each supplier product and variant, and the admin search and view pages show the
unmodified JSON, so field mappings can be checked against what CJ actually returned.

## Data model (see `prisma/schema.prisma`)

- **Supplier data:** `CjSupplierProduct` (PID, product SKU, name, description, images, raw JSON) and
  `CjSupplierVariant` (VID, variant SKU, name/key, image, supplier price, weight, dimensions,
  inventory total, per-warehouse inventory, timestamps).
- **Our storefront data:** `Product` (title, description, internal SKU, categories, SEO, status,
  delivery estimate), `ProductImage`, and `ProductVariant` (name, options, internal SKU, our price).
- **Bridge:** `SupplierOffer` links one `ProductVariant` to one CJ variant: supplier, PID, product SKU, VID, variant SKU.
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
