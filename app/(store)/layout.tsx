import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import Link from "next/link";
import { config } from "@/lib/config";
import BrandMark from "@/components/BrandMark";
import ShareButton from "@/components/ShareButton";
import { cartCount, getShipTo } from "@/lib/cart";
import { countryLabel } from "@/lib/shipping";

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const [count, shipTo] = await Promise.all([cartCount(), getShipTo()]);
  return (
    <div className="store">
      <div className="announce">{config.storeTagline} · Shipping to {countryLabel(shipTo.country)} shown before you pay</div>
      <header className="store-header">
        <div className="wrap header-row">
          <Link href="/" className="brand" aria-label={`${config.storeName} home`}>
            <span className="brand-name">{config.storeName}</span>
          </Link>
          <nav className="header-nav" aria-label="Main">
            <Link href="/">Assistant</Link>
            <Link href="/picks">Picks</Link>
            <Link href="/plans">Plans</Link>
          </nav>
          <Link href="/account" className="search-link account-link" aria-label="Your account">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <circle cx="12" cy="8" r="3.5" />
              <path d="M5 20a7 7 0 0 1 14 0" />
            </svg>
            <span className="hide-xs">Account</span>
          </Link>
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
              <BrandMark />
              <span className="brand-name">{config.storeName}</span>
            </div>
            <p className="footer-blurb">{config.storeTagline}. Text what you need: products from factories worldwide, flights and more, found, priced and paid for in one conversation.</p>
            <ShareButton className="footer-share share-up" url="/" text={`${config.storeName}: ${config.storeTagline}`} label={`Share ${config.storeName}`} />
          </div>
          <div>
            <div className="footer-h">Shop</div>
            <ul className="footer-links">
              <li>
                <Link href="/">Chat to buy</Link>
              </li>
              <li>
                <Link href="/picks">Vetted picks</Link>
              </li>
              <li>
                <Link href="/plans">Plans</Link>
              </li>
            </ul>
          </div>
          <div>
            <div className="footer-h">Tools</div>
            <ul className="footer-links">
              <li>
                <Link href="/cart">Your cart</Link>
              </li>
              <li>
                <Link href="/refunds">Refund policy</Link>
              </li>
              <li>
                <Link href="/track">Track an order</Link>
              </li>
              <li>
                <Link href="/account">Your account</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="wrap footer-base">
          <span>
            © {new Date().getFullYear()} {config.storeName}
          </span>
          <span>
            Product and brand names belong to their owners.
          </span>
        </div>
      </footer>
    </div>
  );
}
