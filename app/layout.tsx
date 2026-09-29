import "./globals.css";
import { config } from "@/lib/config";

export const metadata = { title: config.storeName, description: "Professional tools for working chefs." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
