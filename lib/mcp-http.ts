// Shared bits for the MCP and OAuth endpoints: CORS (browser-based MCP clients and inspectors call them
// cross-site; nothing here uses cookies, so any origin is fine) and a per-address limit on the open endpoints.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function cors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const preflight = () => cors(new Response(null, { status: 204 }));

const hits = new Map<string, number[]>();
/** At most `max` calls per address per window (in memory: enough for one server process). */
export function limited(req: Request, bucket: string, max: number, windowMs = 3600_000): boolean {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return list.length > max;
}

export function oauthError(error: string, description: string, status = 400): Response {
  return cors(Response.json({ error, error_description: description }, { status }));
}
