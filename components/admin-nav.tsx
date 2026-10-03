"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface AdminTab {
  href: string;
  label: string;
  icon: string;
  badge?: number;
}

function isActive(path: string, href: string) {
  return href === "/admin" ? path === "/admin" : path === href || path.startsWith(href + "/");
}

export function AdminDeskNav({ tabs }: { tabs: AdminTab[] }) {
  const path = usePathname();
  return (
    <nav className="admin-desk-nav" aria-label="Admin">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={isActive(path, t.href) ? "on" : ""} aria-current={isActive(path, t.href) ? "page" : undefined}>
          {t.label}
          {t.badge ? <span className="nav-badge">{t.badge}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function AdminTabBar({ tabs }: { tabs: AdminTab[] }) {
  const path = usePathname();
  return (
    <nav className="admin-tabbar" aria-label="Admin sections">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={`tab ${isActive(path, t.href) ? "on" : ""}`} aria-current={isActive(path, t.href) ? "page" : undefined}>
          <span className="tab-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={t.icon} />
            </svg>
            {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
          </span>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
