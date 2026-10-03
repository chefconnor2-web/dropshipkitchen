import Link from "next/link";
import { cartShipItems, getCartId, getShipTo, loadCart } from "@/lib/cart";
import { SHIP_COUNTRIES, daysLabel, quoteTiers, type ShipTier } from "@/lib/shipping";
import { formatMoney } from "@/lib/money";
import { stockLabel, stockStatus } from "@/lib/inventory";
import { checkout, updateCartItem, updateShipTo } from "../actions";

export const dynamic = "force-dynamic";

export default async function CartPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const cart = await loadCart(await getCartId());
  const items = cart?.items ?? [];
  const subtotal = items.reduce((s, i) => s + i.variant.priceCents * i.quantity, 0);
  const units = items.reduce((s, i) => s + i.quantity, 0);
  const shipTo = await getShipTo();
  let tiers: ShipTier[] = [];
  let shipError: string | null = null;
  if (items.length) {
    try {
      tiers = await quoteTiers(cartShipItems(cart), shipTo.country, shipTo.zip);
      if (!tiers.length) shipError = "These items can’t ship to that country.";
    } catch {
      shipError = "We couldn’t get a shipping price right now. Refresh to try again.";
    }
  }
  const tier = tiers.find((t) => t.key === shipTo.tier) ?? tiers[0];
  const shipping = tier?.cents ?? null;

  return (
    <div className="wrap page">
      <h1 className="page-title">Your cart</h1>
      {error && <p className="notice err">{error}</p>}
      {items.length === 0 ? (
        <div className="empty-cart">
          <p>Your cart is empty.</p>
          <Link href="/shop" className="btn primary">
            Browse the shop
          </Link>
        </div>
      ) : (
        <div className="cart">
          <ul className="cart-items">
            {items.map((i) => {
              // Server component: only the derived label reaches the page, never the supplier's count.
              const s = stockStatus(i.variant.offer?.cjSupplierVariant.inventoryTotal);
              const productImg = i.variant.product.images[0];
              const src = i.variant.imageUrl ? `/media/v/${i.variant.id}` : productImg ? `/media/${productImg.id}` : null;
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
                    <strong>{formatMoney(i.variant.priceCents * i.quantity)}</strong>
                    {i.quantity > 1 && <div className="muted small">{formatMoney(i.variant.priceCents)} each</div>}
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
                      <span className="ship-tier-days">{daysLabel(t)}</span>
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
              <dt>Shipping{tier ? ` · ${tier.label}` : ""}</dt>
              <dd>{shipping == null ? "—" : formatMoney(shipping)}</dd>
            </dl>
            <div className="summary-total">
              <span>Total</span>
              <strong>{formatMoney(subtotal + (shipping ?? 0))}</strong>
            </div>
            <form action={checkout}>
              <button className="btn primary lg block" disabled={!tier}>
                Checkout
              </button>
            </form>
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
