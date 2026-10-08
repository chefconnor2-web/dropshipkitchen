// The preview card when a shared trip is posted: "Join Connor's trip to Toronto", the route, dates and
// airline, with Bubble Guy. 1200×630, cached for an hour.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { tripDates, tripTitle } from "@/lib/shared-trips";
import type { FlightCard } from "@/lib/flights-shared";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const trip = await prisma.sharedTrip.findUnique({ where: { slug: (await params).slug } });
  if (!trip) return new Response("Not found", { status: 404 });
  const card = JSON.parse(trip.cardJson) as FlightCard;
  const first = card.slices[0];
  const back = card.slices.length === 2 && card.slices[1]?.to === first?.from;
  const route = first ? `${first.from} ${back ? "⇄" : "→"} ${card.slices[card.slices.length - 1].to}` : "";
  const blob = await readFile(path.join(process.cwd(), "public/brand/blob.png"));
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", gap: 50, padding: "0 80px", background: "#FAF6F1", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
          <div style={{ fontSize: 30, color: "#B5462B", letterSpacing: 2, textTransform: "uppercase" }}>Trip with friends</div>
          <div style={{ fontSize: 68, color: "#1D1C1A", lineHeight: 1.05 }}>{tripTitle(card, trip.hostName)}</div>
          <div style={{ fontSize: 84, color: "#1D1C1A", letterSpacing: 2, marginTop: 6 }}>{route}</div>
          <div style={{ fontSize: 36, color: "#5B5650" }}>{`${tripDates(card)} · ${card.airline}`}</div>
          <div style={{ fontSize: 30, color: "#5B5650", marginTop: 10 }}>{`Book the same flights on ${config.storeName}`}</div>
        </div>
        <img src={`data:image/png;base64,${blob.toString("base64")}`} width={300} height={300} alt="" />
      </div>
    ),
    { width: 1200, height: 630, headers: { "cache-control": "public, max-age=3600" } },
  );
}
