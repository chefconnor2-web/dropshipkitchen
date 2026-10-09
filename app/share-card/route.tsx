// The preview card when the site itself is shared (chat, shop, any page without its own picture): Bubble Guy,
// the name and the tagline, 1200×630. Set as the default og:image in app/layout.tsx; product and box pages
// use their own photo instead.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { config } from "@/lib/config";

const size = { width: 1200, height: 630 };

export async function GET() {
  const blob = await readFile(path.join(process.cwd(), "public/brand/agents/neon.png"));
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", gap: 56, padding: "0 90px", background: "#FAF6F1", fontFamily: "sans-serif" }}>
        <img src={`data:image/png;base64,${blob.toString("base64")}`} width={360} height={360} alt="" />
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 120, fontWeight: 800, color: "#1D1C1A", letterSpacing: -3 }}>{config.storeName}</div>
          <div style={{ fontSize: 44, color: "#5B5650", lineHeight: 1.2, maxWidth: 620 }}>{config.storeTagline}</div>
          <div style={{ fontSize: 30, color: "#B5462B", marginTop: 8 }}>Text what you need. Pay right in the chat.</div>
        </div>
      </div>
    ),
    { ...size, headers: { "cache-control": "public, max-age=3600" } },
  );
}
