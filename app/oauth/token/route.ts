import { exchange } from "@/lib/mcp-auth";
import { cors, limited, oauthError, preflight } from "@/lib/mcp-http";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request) {
  if (limited(req, "token", 120)) return oauthError("too_many_requests", "Too many requests. Try again later.", 429);
  const type = req.headers.get("content-type") ?? "";
  const form = type.includes("application/json") ? new URLSearchParams(Object.entries((await req.json().catch(() => ({}))) as Record<string, string>)) : new URLSearchParams(await req.text());
  const r = await exchange(form);
  if ("error" in r) return oauthError(r.error, r.error_description);
  return cors(Response.json(r));
}
