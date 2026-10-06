import { Suspense } from "react";
import Link from "next/link";
import { withCjPriority } from "@/lib/cj/lanes";
import { designLabel } from "@/lib/personalize";
import { cartBoxPicks, cartShipItems, getCartId, getShipTo, loadCart } from "@/lib/cart";
import { SEA_DAYS, seaEligible, usOnly, warehousesFrom } from "@/lib/warehouses";
import { SHIP_COUNTRIES, blockedMessage, countryLabel, daysLabel, estimateFromHistory, parcelsLabel, quoteCart, type CartQuote, type ShipEstimate, type ShipTier } from "@/lib/shipping";
import { formatMoney } from "@/lib/money";
import { BULK_MIN_UNITS, priceOrder } from "@/lib/volume";
import { ensureFreshInventory, stockLabel, stockStatus } from "@/lib/inventory";
import CheckoutButton from "@/components/store/CheckoutButton";
import { checkout, removeCartBox, requestFreightQuote, updateCartItem, updateShipTo } from "../actions";
import { suggestFreight } from "@/lib/freight";

export const dynamic = "force-dynamic";

export default async function CartPage({ searchParams }: { searchParams: Promise<{ error?: string; freight?: string }> }) {
  const { error, freight } = await searchParams;
  const cart = await loadCart(await getCartId());
  const items = cart?.items ?? [];
  // The whole cart is priced as one transaction: bigger orders pay a lower margin.
  const priced = priceOrder(items.map((i) => ({ listCents: i.variant.priceCents, costCents: i.variant.offer?.cjSupplierVariant.supplierPriceCents, quantity: i.quantity })));
  const unit = (i: (typeof items)[number]) => priced.unitCents[items.indexOf(i)];
  const boxes = cart?.boxes ?? [];
  const boxTotal = boxes.reduce((n, b) => n + b.box.priceCents, 0);
  const subtotal = priced.totalCents + boxTotal;
  const savings = priced.savingsCents;
  const units = items.reduce((s, i) => s + i.quantity, 0) + boxes.length;
  const shipTo = await getShipTo();
  // Shipping is CJ's live quote and can take seconds, so the cart renders now and the quote streams into
  // the summary (usually it's already cached: adding to the cart starts it in the background).
  const picks = items.length || boxes.length ? await cartBoxPicks(cart).catch(() => []) : [];
  const shipItems = cartShipItems(cart, picks);
  // Shown while a never-quoted cart waits on CJ: an estimate from earlier quotes (database only, fast).
  const estimate = shipItems.length ? await estimateFromHistory(shipItems, shipTo.country) : null;
  const quote: Promise<ShipState> =
    items.length || boxes.length
      ? Promise.resolve(picks)
          .then((picks) => shipState(withCjPriority("urgent", () => quoteCart(cartShipItems(cart, picks), shipTo.country, shipTo.zip)), items, shipTo.country))
          .catch(() => ({ tiers: [], blocked: [], error: "We couldn’t get a shipping price right now. Refresh to try again." }))
      : Promise.resolve({ tiers: [], blocked: [], error: null });
  const showFreightBase = items.length > 0;
  // Checkout re-checks stale stock with CJ before payment; do it now, in the background, so that's instant.
  const svIds = items.flatMap((i) => (i.variant.offer ? [i.variant.offer.cjSupplierVariantId] : []));
  if (svIds.length) void withCjPriority("background", () => ensureFreshInventory(svIds)).catch(() => null);
  // A new key per cart state makes React show the "getting prices" state at once after a change,
  // instead of holding the old summary until the new quote arrives.
  const quoteKey = JSON.stringify([items.map((i) => [i.id, i.quantity]), boxes.map((b) => b.id), shipTo]);
  return (
    <div className="wrap page">
      <h1 className="page-title">Your cart</h1>
      {error && <p className="notice err">{error}</p>}
      {freight === "sent" && <p className="notice ok">Shipping quote requested. We’ll email you within one business day.</p>}
      {items.length === 0 && boxes.length === 0 ? (
        <div className="empty-cart">
          <p>Your cart is empty.</p>
          <Link href="/shop" className="btn primary">
            Browse the shop
          </Link>
        </div>
      ) : (
        <div className="cart">
          <ul className="cart-items">
            {boxes.map((b) => (
              <li key={b.id} className="cart-item">
                <Link href={`/boxes/${b.box.slug}`} className="cart-thumb">
                  <div className="img-ph box-ph" aria-hidden>
                    ?
                  </div>
                </Link>
                <div className="cart-item-main">
                  <Link href={`/boxes/${b.box.slug}`} className="cart-item-title">
                    {b.box.name}
                  </Link>
                  <div className="muted small">
                    Mystery box · {b.box.itemCount} items worth {formatMoney(b.box.guaranteedValueCents)}+ · revealed after purchase
                  </div>
                  <div className="cart-item-actions">
                    <form action={removeCartBox}>
                      <input type="hidden" name="id" value={b.id} />
                      <button className="link-btn small">Remove</button>
                    </form>
                  </div>
                </div>
                <div className="cart-item-price">
                  <strong>{formatMoney(b.box.priceCents)}</strong>
                </div>
              </li>
            ))}
            {items.map((i) => {
              // Server component: only the derived label reaches the page, never the supplier's count.
              const s = stockStatus(i.variant.offer?.cjSupplierVariant.inventoryTotal);
              const productImg = i.variant.product.images[0];
              const src = i.personalization
                ? `/pod/${i.personalization.id}/preview`
                : i.variant.imageUrl
                  ? `/media/v/${i.variant.id}`
                  : productImg
                    ? `/media/${productImg.id}`
                    : null;
              const design = designLabel(i.personalization);
              return (
                <li key={i.id} className="cart-item">
                  <Link href={`/products/${i.variant.product.slug}`} className="cart-thumb">
                    {src ? <img src={src} alt="" /> : <div className="img-ph" />}
                  </Link>
                  <div className="cart-item-main">
                    <Link href={`/products/${i.variant.product.slug}`} className="cart-item-title">
                      {i.variant.product.title}
                    </Link>
                    {i.variant.name && !/^default$/i.test(i.variant.name) && <div className="muted small">{i.variant.name}</div>}
                    {design && <div className="cart-design small">{design}</div>}
                    {i.variant.offer && (
                      <Suspense key={quoteKey} fallback={null}>
                        <BlockedMark
                          quote={quote}
                          vid={i.variant.offer.cjSupplierVariant.cjVariantId}
                          country={shipTo.country}
                          usWarehouseOnly={usOnly(warehousesFrom([i.variant.offer.cjSupplierVariant.inventoryJson]))}
                        />
                      </Suspense>
                    )}
                    <div className={`stock stock-${s} small`}>
                      <span className="dot" aria-hidden /> {stockLabel(s)}
                    </div>
                    <div className="cart-item-actions">
                      <form action={updateCartItem} className="qty-form">
                        <input type="hidden" name="itemId" value={i.id} />
                        <label className="sr-only" htmlFor={`qty-${i.id}`}>
                          Quantity
                        </label>
                        <input id={`qty-${i.id}`} className="qty" type="number" name="quantity" min={1} max={99} defaultValue={i.quantity} />
                        <button className="btn small">Update</button>
                      </form>
                      <form action={updateCartItem}>
                        <input type="hidden" name="itemId" value={i.id} />
                        <input type="hidden" name="quantity" value="0" />
                        <button className="link-btn small">Remove</button>
                      </form>
                    </div>
                  </div>
                  <div className="cart-item-price">
                    <strong>{formatMoney(unit(i) * i.quantity)}</strong>
                    {i.quantity > 1 && <div className="muted small">{formatMoney(unit(i))} each</div>}
                    {unit(i) < i.variant.priceCents && (
                      <div className="vol-save small">
                        Bulk price · was {formatMoney(i.variant.priceCents)}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <aside className="summary" aria-label="Order summary">
            <h2 className="summary-title">Order summary</h2>
            <form action={updateShipTo} className="ship-to">
              <div className="ship-to-row">
                <label>
                  <span>Ship to</span>
                  <select name="country" defaultValue={shipTo.country}>
                    {SHIP_COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>ZIP / postcode</span>
                  <input name="zip" defaultValue={shipTo.zip} autoComplete="postal-code" placeholder="Optional" />
                </label>
              </div>
              <button className="btn small">Update shipping</button>
            </form>
            <Suspense key={quoteKey} fallback={<ShippingPending subtotal={subtotal} units={units} savings={savings} estimate={estimate} />}>
              <ShippingSummary quote={quote} shipToTier={shipTo.tier} subtotal={subtotal} units={units} savings={savings} offerFreight={showFreightBase} freightSent={freight === "sent"} />
            </Suspense>
            <p className="muted small summary-note">
              Availability and shipping are re-confirmed with our supplier before payment. You’ll enter your full address at checkout.
            </p>
            <Link href="/shop" className="small summary-continue">
              ← Continue shopping
            </Link>
          </aside>
        </div>
      )}
    </div>
  );
}

type CartItems = NonNullable<Awaited<ReturnType<typeof loadCart>>>["items"];
interface ShipState {
  tiers: ShipTier[];
  blocked: string[];
  error: string | null;
  /** Blocked items that can go by sea instead (China → Canada), by name. */
  sea?: string[];
}

async function shipState(q: Promise<CartQuote>, items: CartItems, country: string): Promise<ShipState> {
  try {
    const { tiers, blocked } = await q;
    if (tiers.length) return { tiers, blocked, error: null };
    const itemOf = (vid: string) => items.find((i) => i.variant.offer?.cjSupplierVariant.cjVariantId === vid);
    // Can't fly, but can sail: China → Canada by boat, quoted per order (big lithium batteries, mostly).
    const seaVids = blocked.filter((vid) => seaEligible(warehousesFrom([itemOf(vid)?.variant.offer?.cjSupplierVariant.inventoryJson]), country));
    const sea = [...new Set(seaVids.map((vid) => itemOf(vid)?.variant.product.title ?? "An item"))];
    const rest = blocked.filter((vid) => !seaVids.includes(vid));
    if (sea.length && !rest.length) {
      const list = sea.length === 1 ? sea[0] : `${sea.slice(0, -1).join(", ")} and ${sea[sea.length - 1]}`;
      return {
        tiers,
        blocked,
        sea,
        error: `${list} can’t fly to Canada (large lithium batteries go by boat). It ships by sea from China instead, ${SEA_DAYS}: get a sea-shipping price below, or remove ${sea.length === 1 ? "it" : "them"} to check out the rest now.`,
      };
    }
    const error =
      blockedMessage(
        blocked,
        (vid) => items.find((i) => i.variant.offer?.cjSupplierVariant.cjVariantId === vid)?.variant.product.title,
        country,
        (vid) => usOnly(warehousesFrom([items.find((i) => i.variant.offer?.cjSupplierVariant.cjVariantId === vid)?.variant.offer?.cjSupplierVariant.inventoryJson])),
      ) ??
      (items.reduce((n, i) => n + i.quantity, 0) >= 20
        ? "This order is too large to ship, even split into parcels. Lower the quantity or contact us for a freight quote."
        : "These items can’t ship to that country.");
    return { tiers, blocked, error, sea };
  } catch {
    return { tiers: [], blocked: [], error: "We couldn’t get a shipping price right now. Refresh to try again." };
  }
}

async function BlockedMark({ quote, vid, country, usWarehouseOnly }: { quote: Promise<ShipState>; vid: string; country: string; usWarehouseOnly: boolean }) {
  const { blocked } = await quote;
  if (!blocked.includes(vid)) return null;
  if (!usWarehouseOnly && country === "CA") return <div className="sea-text small">🚢 Ships to Canada by sea · {SEA_DAYS}</div>;
  return (
    <div className="err-text small">
      {usWarehouseOnly && country !== "US" ? "US warehouse · ships to US addresses only" : `Can’t ship to ${countryLabel(country)}`}
    </div>
  );
}

function SummaryRows({ subtotal, units, savings, shipping, tierLabel }: { subtotal: number; units: number; savings: number; shipping: React.ReactNode; tierLabel?: string }) {
  return (
    <dl className="summary-rows">
      <dt>
        Subtotal ({units} item{units === 1 ? "" : "s"})
      </dt>
      <dd>{formatMoney(subtotal)}</dd>
      {savings > 0 && (
        <>
          <dt className="vol-save">Bulk savings</dt>
          <dd className="vol-save">−{formatMoney(savings)}</dd>
        </>
      )}
      <dt>Shipping{tierLabel ? ` · ${tierLabel}` : ""}</dt>
      <dd>{shipping}</dd>
    </dl>
  );
}

/** Shown while CJ's quote is on its way: an estimate when we have one, else everything but shipping. */
function ShippingPending({ subtotal, units, savings, estimate }: { subtotal: number; units: number; savings: number; estimate: ShipEstimate | null }) {
  return (
    <>
      <div className="ship-tiers ship-pending" aria-busy="true">
        <span className="ship-pending-dot" aria-hidden /> {estimate ? `Standard ≈ ${formatMoney(estimate.cents)} · confirming the exact price…` : "Getting live shipping prices…"}
      </div>
      <SummaryRows
        subtotal={subtotal}
        units={units}
        savings={savings}
        shipping={estimate ? `≈ ${formatMoney(estimate.cents)}` : <span className="muted">…</span>}
        tierLabel={estimate ? "estimate" : undefined}
      />
      <div className="summary-total">
        <span>Total</span>
        <strong>{estimate ? `≈ ${formatMoney(subtotal + estimate.cents)}` : `${formatMoney(subtotal)} + shipping`}</strong>
      </div>
      <button className="btn primary lg block" disabled>
        Checkout
      </button>
    </>
  );
}

async function ShippingSummary({
  quote,
  shipToTier,
  subtotal,
  units,
  savings,
  offerFreight,
  freightSent,
}: {
  quote: Promise<ShipState>;
  shipToTier: string;
  subtotal: number;
  units: number;
  savings: number;
  offerFreight: boolean;
  freightSent: boolean;
}) {
  const { tiers, error: shipError, sea } = await quote;
  const tier = tiers.find((t) => t.key === shipToTier) ?? tiers[0];
  const shipping = tier?.cents ?? null;
  const showFreight = offerFreight && suggestFreight(subtotal, shipping, units);
  return (
    <>
      {tier?.parcels && tier.parcels.length > 1 && (
        <p className="vol-hint small">Big order: it ships as {tier.parcels.length} parcels, quoted and tracked automatically.</p>
      )}
      {shipError ? (
        <p className="notice err small">{shipError}</p>
      ) : (
        <fieldset className="ship-tiers">
          <legend className="sr-only">Shipping speed</legend>
          {tiers.map((t) => (
            <form key={t.key} action={updateShipTo}>
              <input type="hidden" name="tier" value={t.key} />
              <button className={`ship-tier ${t.key === tier?.key ? "on" : ""}`} aria-pressed={t.key === tier?.key}>
                <span className="ship-tier-name">{t.label}</span>
                <span className="ship-tier-days">{[parcelsLabel(t), daysLabel(t)].filter(Boolean).join(" · ")}</span>
                <span className="ship-tier-price">{formatMoney(t.cents)}</span>
              </button>
            </form>
          ))}
        </fieldset>
      )}
      <SummaryRows subtotal={subtotal} units={units} savings={savings} shipping={shipping == null ? "—" : formatMoney(shipping)} tierLabel={tier?.label} />
      {savings === 0 && <p className="vol-hint small">Order {BULK_MIN_UNITS}+ units or $100+ and bulk pricing kicks in automatically.</p>}
      <div className="summary-total">
        <span>Total</span>
        <strong>{formatMoney(subtotal + (shipping ?? 0))}</strong>
      </div>
      <form action={checkout}>
        <CheckoutButton disabled={!tier} />
      </form>
      {!!sea?.length && !freightSent && (
        <div className="freight-box sea-box">
          <p>
            <strong>🚢 Ship by sea to Canada</strong>
            <span className="muted small"> · {SEA_DAYS} from China</span>
          </p>
          <form action={requestFreightQuote} className="freight-form">
            <input type="hidden" name="mode" value="sea" />
            <input name="email" type="email" required placeholder="Your email" autoComplete="email" />
            <textarea name="notes" rows={2} placeholder="Delivery address area, deadline… (optional)" />
            <button className="btn primary">Get a sea-shipping price</button>
            <p className="muted small">We book it with our supplier and email you the price within one business day. Your cart stays as it is.</p>
          </form>
        </div>
      )}
      {showFreight && !sea?.length && !freightSent && (
        <details className="freight-box" open={!tier}>
          <summary>
            <strong>Large order? Get a freight quote</strong>
            <span className="muted small"> · often cheaper than parcels for pallets and heavy goods</span>
          </summary>
          <form action={requestFreightQuote} className="freight-form">
            <input name="email" type="email" required placeholder="Your email" autoComplete="email" />
            <input name="company" placeholder="Company (optional)" autoComplete="organization" />
            <textarea name="notes" rows={2} placeholder="Delivery details, deadline, loading dock… (optional)" />
            <button className="btn">Request freight quote</button>
            <p className="muted small">We arrange sea or air freight with our supplier and email you a price. Your cart stays as it is.</p>
          </form>
        </details>
      )}
    </>
  );
}
