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

  return (
    <>
      <h1>Your cart</h1>
      {error && <p className="notice err">{error}</p>}
      {items.length === 0 ? (
        <p className="muted">
          Your cart is empty. <Link href="/shop">Continue shopping →</Link>
        </p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Price</th>
                <th>Qty</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const s = stockStatus(i.variant.offer?.cjSupplierVariant.inventoryTotal);
                const img = i.variant.product.images[0];
                return (
                  <tr key={i.id}>
                    <td>
                      <div className="row gap">
                        {img && <img className="thumb" src={`/media/${img.id}`} alt="" />}
                        <div>
                          <Link href={`/products/${i.variant.product.slug}`}>{i.variant.product.title}</Link>
                          <div className="muted small">{i.variant.name}</div>
                          <span className={`stock stock-${s} small`}>{stockLabel(s)}</span>
                        </div>
                      </div>
                    </td>
                    <td>{formatMoney(i.variant.priceCents)}</td>
                    <td>
                      <form action={updateCartItem} className="row gap">
                        <input type="hidden" name="itemId" value={i.id} />
                        <input className="qty" type="number" name="quantity" min={0} max={99} defaultValue={i.quantity} />
                        <button className="btn small">Update</button>
                      </form>
                    </td>
                    <td>{formatMoney(i.variant.priceCents * i.quantity)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row between cart-foot">
            <span className="muted small">Set quantity to 0 to remove. Availability is re-confirmed at checkout.</span>
            <form action={checkout} className="row gap">
              <strong>Subtotal {formatMoney(subtotal)}</strong>
              <button className="btn primary">Checkout</button>
            </form>
          </div>
        </>
      )}
    </>
  );
}
