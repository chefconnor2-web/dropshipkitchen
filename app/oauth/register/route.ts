import { registerClient } from "@/lib/mcp-auth";
import { cors, limited, oauthError, preflight } from "@/lib/mcp-http";

// OAuth dynamic client registration (RFC 7591): Claude and ChatGPT register themselves when a connector is added.
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request) {
  if (limited(req, "register", 30)) return oauthError("too_many_requests", "Too many registrations. Try again later.", 429);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return oauthError("invalid_client_metadata", "Send the client metadata as JSON.");
  const r = await registerClient(body as Record<string, unknown>);
  if ("error" in r) return oauthError("invalid_redirect_uri", String(r.error));
  return cors(Response.json(r, { status: 201 }));
}
