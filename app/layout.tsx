import "./globals.css";
import { config } from "@/lib/config";
import type { Metadata } from "next";

// metadataBase turns relative image paths (product photos, /share-card) into the absolute links that
// Facebook, WhatsApp, X and friends need for the preview card when someone shares a page.
export const metadata: Metadata = {
  metadataBase: new URL(config.siteUrl),
  title: config.storeName,
  description: `${config.storeTagline}.`,
  openGraph: { siteName: config.storeName, type: "website", images: [{ url: "/share-card", width: 1200, height: 630, alt: config.storeName }] },
  twitter: { card: "summary_large_image", images: ["/share-card"] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
