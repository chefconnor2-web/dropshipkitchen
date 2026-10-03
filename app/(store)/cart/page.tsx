import Link from "next/link";
import { getCartId, loadCart } from "@/lib/cart";
import { formatMoney } from "@/lib/money";
import { stockLabel, stockStatus } from "@/lib/inventory";
import { checkout, updateCartItem } from "../actions";

export const dynamic = "force-dynamic";

export default async function CartPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const cart = await loadCart(await getCartId());
  const items = cart?.items ?? [];
  const subtotal = items.reduce((s, i) => s + i.variant.priceCents * i.quantity, 0);
  const units = items.reduce((s, i) => s + i.quantity, 0);

  return (
    <>
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
            <dl className="summary-rows">
              <dt>
                Subtotal ({units} item{units === 1 ? "" : "s"})
              </dt>
              <dd>{formatMoney(subtotal)}</dd>
            </dl>
            <div className="summary-total">
              <span>Total</span>
              <strong>{formatMoney(subtotal)}</strong>
            </div>
            <form action={checkout}>
              <button className="btn primary lg block">Checkout</button>
            </form>
            <p className="muted small summary-note">
              Availability is re-confirmed before payment. You’ll enter your shipping address at checkout.
            </p>
            <Link href="/shop" className="small summary-continue">
              ← Continue shopping
            </Link>
          </aside>
        </div>
      )}
    </>
  );
}
