// GET /api/google/callback: Google's answer. Checks the state cookie, stores the (encrypted) refresh token for
// this shopper (account, else browser), and goes back to where they started.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { config } from "@/lib/config";
import { connectGmail } from "@/lib/gmail";
import { getVisitorId } from "@/lib/chat-session";
import { getMemberId, safeNext } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const jar = await cookies();
  let saved: { state?: string; back?: string } = {};
  try {
    saved = JSON.parse(jar.get("cs_gstate")?.value ?? "{}");
  } catch {}
  const back = safeNext(saved.back);
  const go = (status: string) => {
    const url = new URL(back, config.siteUrl);
    url.searchParams.set("gmail", status);
    const res = NextResponse.redirect(url);
    res.cookies.delete({ name: "cs_gstate", path: "/api/google" });
    return res;
  };
  if (!saved.state || saved.state !== q.get("state")) return go("failed");
  if (q.get("error") || !q.get("code")) return go("cancelled");
  try {
    const r = await connectGmail(q.get("code")!, { customerId: await getMemberId(), visitorId: await getVisitorId() });
    return go("error" in r ? "failed" : "connected");
  } catch (e) {
    console.error("[gmail] connect failed:", e instanceof Error ? e.message : e);
    return go("failed");
  }
}
