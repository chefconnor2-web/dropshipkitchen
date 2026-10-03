import "./globals.css";
import { config } from "@/lib/config";

export const metadata = { title: config.storeName, description: "Off-grid power and gear for portable Starlink." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
