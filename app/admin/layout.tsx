import "@fontsource/ibm-plex-sans/400.css";
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
    { href: "/admin/products", label: "Products", icon: "M4 8l8-4 8 4-8 4-8-4zm0 0v8l8 4 8-4V8" },
    { href: "/admin/suppliers/cj", label: "Find on CJ", icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.5-4.5" },
    { href: "/admin", label: "Dashboard", icon: "M4 13h6V4H4zm10 7h6V4h-6zM4 20h6v-4H4z" },
  ];
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
