import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import Link from "next/link";
import { config } from "@/lib/config";
import { cartCount } from "@/lib/cart";
import { publishedCategories } from "@/lib/storefront";

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const [count, categories] = await Promise.all([cartCount(), publishedCategories()]);
  return (
    <div className="store">
      <div className="announce">Availability confirmed before every order · Secure checkout</div>
      <header className="store-header">
        <div className="wrap header-row">
          <Link href="/shop" className="brand" aria-label={`${config.storeName} home`}>
            <span className="brand-mark" aria-hidden>
              CS
            </span>
            <span className="brand-name">{config.storeName}</span>
          </Link>
          <nav className="header-nav" aria-label="Main">
            <Link href="/shop">Shop all</Link>
            {categories.slice(0, 4).map((c) => (
              <Link key={c.name} href={`/shop?category=${encodeURIComponent(c.name)}`} className="hide-sm">
                {c.name}
              </Link>
            ))}
          </nav>
          <Link href="/cart" className="cart-link" aria-label={`Cart, ${count} item${count === 1 ? "" : "s"}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M6 7h12l-1 13H7L6 7Z" />
              <path d="M9 7a3 3 0 0 1 6 0" />
            </svg>
            <span>Cart</span>
            {count > 0 && <span className="cart-badge">{count}</span>}
          </Link>
        </div>
      </header>
      <main className="wrap store-main">{children}</main>
      <footer className="store-footer">
        <div className="wrap footer-grid">
          <div>
            <div className="brand footer-brand">
              <span className="brand-mark" aria-hidden>
                CS
              </span>
              <span className="brand-name">{config.storeName}</span>
            </div>
            <p className="muted small footer-blurb">
              Professional tools for working chefs: plating, pastry, prep and measuring essentials.
            </p>
          </div>
          {categories.length > 0 && (
            <div>
              <div className="footer-h">Shop</div>
              <ul className="footer-links">
                <li>
                  <Link href="/shop">All products</Link>
                </li>
                {categories.map((c) => (
                  <li key={c.name}>
                    <Link href={`/shop?category=${encodeURIComponent(c.name)}`}>{c.name}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="footer-h">Ordering</div>
            <ul className="footer-links">
              <li>
                <Link href="/cart">Your cart</Link>
              </li>
              <li className="muted">Stock is re-checked before payment</li>
              <li className="muted">Payments processed by Stripe</li>
            </ul>
          </div>
        </div>
        <div className="wrap footer-base small muted">
          © {new Date().getFullYear()} {config.storeName}
        </div>
      </footer>
    </div>
  );
}
