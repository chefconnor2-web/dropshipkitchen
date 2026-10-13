// GET /api/google/connect?back=/c/<chat>: starts connecting the shopper's Gmail (send-only). A state cookie ties
// Google's answer to this browser; the shopper comes back to `back` (a path on this site).
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { authUrl, gmailConfigured } from "@/lib/gmail";
import { ensureVisitorId } from "@/lib/chat-session";
import { safeNext } from "@/lib/session";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!gmailConfigured()) return new Response("Gmail isn't set up on this store yet.", { status: 503 });
  await ensureVisitorId();
  const state = randomBytes(18).toString("base64url");
  const back = safeNext(new URL(req.url).searchParams.get("back"));
  const res = NextResponse.redirect(authUrl(state));
  res.cookies.set("cs_gstate", JSON.stringify({ state, back }), { httpOnly: true, sameSite: "lax", secure: config.siteUrl.startsWith("https:"), path: "/api/google", maxAge: 600 });
  return res;
}
