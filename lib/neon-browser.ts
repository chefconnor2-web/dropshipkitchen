// Neon Browser is a companion app (a separate Floot app) that talks to Chit over a single server-side key, and
// acts for the store owner's own account. It never automates or proxies third-party sites; it reads the catalog
// and runs Neon turns, and shopping is handed off to the owner's own store accounts via links.
//
// NEON_BROWSER_KEY  the shared secret the companion's backend sends in `x-neon-key` (set the same value here and
//                   in the companion app). When unset, the endpoints are off.

import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Who } from "@/lib/mcp-kit";

/** Constant-time check of the companion's key against NEON_BROWSER_KEY. Off (always false) when unset. */
export function neonKeyOk(header: string | null | undefined): boolean {
  const key = process.env.NEON_BROWSER_KEY?.trim();
  const got = (header ?? "").trim();
  if (!key || !got) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ownerEmail(): string | null {
  return (
    `${process.env.OWNER_EMAILS ?? ""},${process.env.EXTRA_OWNER_EMAILS ?? ""}`
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)[0] ?? null
  );
}

/** The owner account the companion acts for. Returns null when no OWNER_EMAILS is configured. */
export async function ownerWho(): Promise<Who | null> {
  const email = ownerEmail();
  if (!email) return null;
  const customer = await prisma.customer.upsert({ where: { email }, create: { email }, update: {} });
  return { customerId: customer.id, clientId: "neon-browser", clientName: "Neon Browser" };
}
