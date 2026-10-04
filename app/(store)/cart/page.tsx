import Link from "next/link";
import { designLabel } from "@/lib/personalize";
import { cartBoxPicks, cartShipItems, getCartId, getShipTo, loadCart } from "@/lib/cart";
import { SHIP_COUNTRIES, daysLabel, parcelsLabel, quoteTiers, type ShipTier } from "@/lib/shipping";
import { formatMoney } from "@/lib/money";
import { BULK_MIN_UNITS, priceOrder } from "@/lib/volume";
import { stockLabel, stockStatus } from "@/lib/inventory";
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
  let tiers: ShipTier[] = [];
  let shipError: string | null = null;
  if (items.length || boxes.length) {
    try {
      tiers = await quoteTiers(cartShipItems(cart, await cartBoxPicks(cart)), shipTo.country, shipTo.zip);
      if (!tiers.length)
        shipError =
          items.reduce((n, i) => n + i.quantity, 0) >= 20
            ? "This order is too large to ship, even split into parcels. Lower the quantity or contact us for a freight quote."
            : "These items can’t ship to that country.";
    } catch {
      shipError = "We couldn’t get a shipping price right now. Refresh to try again.";
    }
  }
  const tier = tiers.find((t) => t.key === shipTo.tier) ?? tiers[0];
  const shipping = tier?.cents ?? null;
  const showFreight = items.length > 0 && suggestFreight(subtotal, shipping, units);

  return (
    <div className="wrap page">
      <h1 className="page-title">Your cart</h1>
      {error && <p className="notice err">{error}</p>}
      {freight === "sent" && <p className="notice ok">Freight quote requested. We’ll email you within one business day.</p>}
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
              <dt>Shipping{tier ? ` · ${tier.label}` : ""}</dt>
              <dd>{shipping == null ? "—" : formatMoney(shipping)}</dd>
            </dl>
            {savings === 0 && (
              <p className="vol-hint small">Order {BULK_MIN_UNITS}+ units or $100+ and bulk pricing kicks in automatically.</p>
            )}
            <div className="summary-total">
              <span>Total</span>
              <strong>{formatMoney(subtotal + (shipping ?? 0))}</strong>
            </div>
            <form action={checkout}>
              <button className="btn primary lg block" disabled={!tier}>
                Checkout
              </button>
            </form>
            {showFreight && freight !== "sent" && (
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
