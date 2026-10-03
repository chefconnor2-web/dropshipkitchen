import { NextResponse, type NextRequest } from "next/server";

// Next.js 404s a static chunk whose route-group parentheses arrive percent-encoded
// ("/_next/static/chunks/app/%28store%29/…"), which some proxies and clients send.
// Serve the same file under its literal path instead.
function staticChunk(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!/%28|%29/i.test(pathname)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = pathname.replace(/%28/gi, "(").replace(/%29/gi, ")");
  return NextResponse.rewrite(url);
}

// HTTP Basic auth for everything under /admin. Set ADMIN_PASSWORD (and optionally ADMIN_USER).
export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/_next/static/")) return staticChunk(req);
  const password = process.env.ADMIN_PASSWORD;
  const user = process.env.ADMIN_USER || "admin";
  if (!password) {
    if (process.env.NODE_ENV === "production")
      return new NextResponse("Admin is disabled: set ADMIN_PASSWORD.", { status: 503 });
    return NextResponse.next(); // local development convenience
  }
  const header = req.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    try {
      const [u, ...rest] = atob(encoded).split(":");
      if (u === user && rest.join(":") === password) return NextResponse.next();
    } catch {
      /* malformed header: fall through to 401 */
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Chef Supply Admin"' },
  });
}

export const config = { matcher: ["/admin", "/admin/:path*", "/_next/static/chunks/app/:path*"] };
