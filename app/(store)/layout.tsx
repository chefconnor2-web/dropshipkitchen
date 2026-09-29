import Link from "next/link";
import { config } from "@/lib/config";
import { cartCount } from "@/lib/cart";

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const count = await cartCount();
  return (
    <div className="store">
      <header className="store-header">
        <div className="wrap row between">
          <Link href="/shop" className="brand">
            <span className="brand-mark">CS</span> {config.storeName}
          </Link>
          <nav className="row gap">
            <Link href="/shop">Shop</Link>
            <Link href="/cart">Cart{count ? ` (${count})` : ""}</Link>
          </nav>
        </div>
      </header>
      <main className="wrap store-main">{children}</main>
      <footer className="store-footer wrap">
        © {new Date().getFullYear()} {config.storeName} · Professional tools for working chefs
      </footer>
    </div>
  );
}
