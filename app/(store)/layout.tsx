import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import Link from "next/link";
import { config, storeInitials } from "@/lib/config";
import { cartCount } from "@/lib/cart";
import { publishedCategories } from "@/lib/storefront";

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const [count, categories] = await Promise.all([cartCount(), publishedCategories()]);
  return (
    <div className="store">
      <div className="announce">Stock confirmed with our supplier before every order · Secure checkout</div>
      <header className="store-header">
        <div className="wrap header-row">
          <Link href="/" className="brand" aria-label={`${config.storeName} home`}>
            <span className="brand-mark" aria-hidden>
              {storeInitials()}
            </span>
            <span className="brand-name">{config.storeName}</span>
          </Link>
          <nav className="header-nav" aria-label="Main">
            <Link href="/#line">Link line</Link>
            <Link href="/shop">Off-grid gear</Link>
            <Link href="/runtime" className="hide-sm">
              Runtime
            </Link>
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
      <main className="store-main">{children}</main>
      <footer className="store-footer">
        <div className="wrap footer-grid">
          <div>
            <div className="brand footer-brand">
              <span className="brand-mark" aria-hidden>
                {storeInitials()}
              </span>
              <span className="brand-name">{config.storeName}</span>
            </div>
            <p className="footer-blurb">Off-grid power for portable Starlink, and the field gear around it.</p>
          </div>
          <div>
            <div className="footer-h">Shop</div>
            <ul className="footer-links">
              <li>
                <Link href="/#line">Link line</Link>
              </li>
              <li>
                <Link href="/shop">All off-grid gear</Link>
              </li>
              {categories.map((c) => (
                <li key={c.name}>
                  <Link href={`/shop?category=${encodeURIComponent(c.name)}`}>{c.name}</Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="footer-h">Tools</div>
            <ul className="footer-links">
              <li>
                <Link href="/runtime">Runtime calculator</Link>
              </li>
              <li>
                <Link href="/cart">Your cart</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="wrap footer-base">
          <span>
            © {new Date().getFullYear()} {config.storeName}
          </span>
          <span>
            DeWalt and 20V MAX are trademarks of Stanley Black &amp; Decker. Starlink is a trademark of SpaceX.{" "}
            {config.storeName} is not affiliated with either.
          </span>
        </div>
      </footer>
    </div>
  );
}
