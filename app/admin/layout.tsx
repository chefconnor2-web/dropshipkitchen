import Link from "next/link";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin", robots: { index: false } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin">
      <header className="admin-header">
        <div className="wrap-wide row between">
          <Link href="/admin" className="brand">
            {config.storeName} <span className="muted">Admin</span>
          </Link>
          <nav className="row gap">
            <Link href="/admin/suppliers/cj">CJ Integration</Link>
            <Link href="/admin/products">Products</Link>
            <Link href="/admin/orders">Orders</Link>
            <Link href="/admin/integration-proof">Integration Proof</Link>
            <Link href="/shop" target="_blank">
              Storefront ↗
            </Link>
          </nav>
        </div>
        <div className="wrap-wide mode-bar small">
          SUPPLIER_MODE=<strong>{config.supplierMode}</strong> · CJ purchasing <strong>DISABLED</strong> · Stripe{" "}
          <strong>TEST MODE</strong> only · CJ catalog, variants, prices &amp; inventory are <strong>LIVE</strong>
        </div>
      </header>
      <main className="wrap-wide admin-main">{children}</main>
    </div>
  );
}
