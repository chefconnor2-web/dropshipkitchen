import { startAuthorize } from "@/lib/mcp-auth";
import { config } from "@/lib/config";

// The app sends the customer's browser here. A valid request becomes a short consent link (sign in first if
// needed); a bad one goes back to the app with an error, or shows a plain message when the app itself is unknown.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const r = await startAuthorize(new URL(req.url).searchParams);
  if ("redirect" in r) return Response.redirect(r.redirect, 302);
  if ("page" in r) return new Response(r.page, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return Response.redirect(`${config.siteUrl}/oauth/consent/${r.requestId}`, 302);
}
