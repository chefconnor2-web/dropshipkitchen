import "@fontsource/ibm-plex-sans/400.css";
import { duffelConfigured, duffelTestMode } from "@/lib/duffel";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/barlow-condensed/700.css";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { config, stripeKeyProblem } from "@/lib/config";
import { supplierMode } from "@/lib/fulfillment";
import { AdminDeskNav, AdminTabBar, type AdminTab } from "@/components/admin-nav";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin", robots: { index: false } };

const MODE_LABEL = { mock: "CJ orders off", sandbox: "CJ sandbox", live: "CJ live" } as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const awaiting = await prisma.order.count({ where: { status: "AWAITING_MERCHANT_APPROVAL" } });
  const mode = supplierMode();
  const stripeReady = !stripeKeyProblem();
  const tabs: AdminTab[] = [
    { href: "/admin/orders", label: "Orders", badge: awaiting, icon: "M4 7h16M4 12h16M4 17h10" },
    { href: "/admin/customers", label: "Customers", icon: "M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7 8v-1a3 3 0 0 0-2-2.8M17 5.2a3 3 0 0 1 0 5.6" },
    { href: "/admin/members", label: "Members", icon: "M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z" },
    { href: "/admin/products", label: "Products", icon: "M4 8l8-4 8 4-8 4-8-4zm0 0v8l8 4 8-4V8" },
    { href: "/admin/suppliers/cj", label: "CJ", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.5-4.5" },
    { href: "/admin", label: "Home", icon: "M4 13h6V4H4zm10 7h6V4h-6zM4 20h6v-4H4z" },
  ];
  if (duffelConfigured()) tabs.splice(tabs.length - 1, 0, { href: "/admin/flights", label: "Flights", icon: "M2 16l20-6-20-6 3 6-3 6zm3-6h9" });
  return (
    <div className="admin">
      <header className="admin-top">
        <div className="admin-top-row">
          <Link href="/admin" className="admin-brand">
            <span className="admin-mark" aria-hidden>
              {config.storeName.slice(0, 1).toUpperCase()}
            </span>
            {config.storeName}
            <span className="admin-brand-sub">Admin</span>
          </Link>
          <AdminDeskNav tabs={tabs} />
        </div>
        <div className="admin-modes" aria-label="Environment">
          <span className={`mode-chip mode-${mode}`}>{MODE_LABEL[mode]}</span>
          <span className={`mode-chip ${stripeReady ? "mode-test" : "mode-off"}`}>{stripeReady ? "Stripe test mode" : "Stripe not set"}</span>
          {duffelConfigured() && <span className={`mode-chip ${duffelTestMode() ? "mode-test" : "mode-live"}`}>{duffelTestMode() ? "Flights test mode" : "Flights live"}</span>}
          <Link href="/" target="_blank" className="mode-chip mode-link">
            View store ↗
          </Link>
        </div>
      </header>
      <main className="admin-main">{children}</main>
      <AdminTabBar tabs={tabs} />
    </div>
  );
}
