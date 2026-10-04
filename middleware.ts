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

// First visit: guess where the shopper is (country and postcode, from their IP address) so shipping prices
// show for their address straight away. They can change it on any product page or in the cart.
// GEOIP_URL sets the lookup service ({ip} is replaced); set it empty to switch guessing off.
const SHIP_COOKIE = "cs_ship";
const GEO_TRIED = "cs_geo";
const SHIP_COUNTRIES = new Set(["CA", "US", "GB", "AU", "NZ", "IE"]);

async function guessShipTo(req: NextRequest): Promise<{ country: string; zip: string } | null> {
  const template = process.env.GEOIP_URL ?? "https://ipwho.is/{ip}";
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "";
  const headerCountry = req.headers.get("cf-ipcountry") || req.headers.get("x-vercel-ip-country");
  if (!template || !ip || /^(10\.|127\.|192\.168\.|::1|fc|fd)/.test(ip)) return headerCountry && SHIP_COUNTRIES.has(headerCountry) ? { country: headerCountry, zip: "" } : null;
  try {
    const r = await fetch(template.replace("{ip}", encodeURIComponent(ip)), { signal: AbortSignal.timeout(800) });
    const d = (await r.json()) as { success?: boolean; country_code?: string; countryCode?: string; postal?: string; zip?: string };
    const country = (d.country_code || d.countryCode || "").toUpperCase();
    if (d.success === false || !SHIP_COUNTRIES.has(country)) return null;
    // Canadian and British postcodes: the area part is enough for a shipping price.
    const zip = String(d.postal || d.zip || "").trim().toUpperCase().slice(0, 12);
    return { country, zip: country === "CA" ? zip.slice(0, 3) : zip };
  } catch {
    return null;
  }
}

async function geoGuess(req: NextRequest) {
  const isPage = req.method === "GET" && (req.headers.get("accept") || "").includes("text/html");
  const bot = /bot|crawl|spider|slurp|curl|wget|preview|monitor|railway/i.test(req.headers.get("user-agent") || "");
  if (!isPage || bot || req.cookies.has(SHIP_COOKIE) || req.cookies.has(GEO_TRIED)) return NextResponse.next();
  const guess = await guessShipTo(req);
  const value = guess ? JSON.stringify({ country: guess.country, zip: guess.zip, tier: "standard" }) : null;
  // Pass the guess to this request's render as well as saving it in the browser.
  if (value) req.cookies.set(SHIP_COOKIE, value);
  const res = NextResponse.next({ request: { headers: req.headers } });
  const year = 60 * 60 * 24 * 365;
  if (value) res.cookies.set(SHIP_COOKIE, value, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  res.cookies.set(GEO_TRIED, "1", { httpOnly: true, sameSite: "lax", path: "/", maxAge: year });
  return res;
}

// HTTP Basic auth for everything under /admin. Set ADMIN_PASSWORD (and optionally ADMIN_USER).
export async function middleware(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/_next/static/")) return staticChunk(req);
  if (!req.nextUrl.pathname.startsWith("/admin")) return geoGuess(req);
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

export const config = {
  matcher: ["/admin", "/admin/:path*", "/_next/static/chunks/app/:path*", "/((?!api|_next|media|pod|icon\\.svg|favicon\\.ico).*)"],
};
