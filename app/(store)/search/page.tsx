import Link from "next/link";
import { config } from "@/lib/config";
import { cjConfigured } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { PAGE_SIZE, searchCatalog, type CatalogHit } from "@/lib/catalog-search";
import { CANADA_DAYS } from "@/lib/warehouses";
import { getShipTo } from "@/lib/cart";
import { SHIP_COUNTRIES } from "@/lib/countries";
import ShipBadge from "@/components/ShipBadge";
import ShipCountryBar from "@/components/ShipCountryBar";

export const dynamic = "force-dynamic";
export const metadata = { title: `Search — ${config.storeName}`, robots: { index: false, follow: false } };

const IDEAS = ["cordless drill", "angle grinder", "socket set", "laser level", "multimeter", "work light", "screwdriver", "battery adapter"];

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; from?: string }> }) {
  const params = await searchParams;
  const q = (params.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Math.min(50, Number(params.page) || 1));
  // from=CA: only what CJ stocks in its Canadian warehouse (delivered in Canada in days, not weeks).
  const fromCanada = params.from === "CA";
  const browsing = !!q || fromCanada;
  let hits: CatalogHit[] = [];
  let total: number | null = null;
  let failed = false;
  if (browsing && cjConfigured()) {
    try {
      ({ hits, total } = await searchCatalog(q, page, fromCanada ? "CA" : undefined));
    } catch {
      failed = true;
    }
  }
  const more = total != null ? page * PAGE_SIZE < total : hits.length > 0;
  const href = (o: { q?: string; page?: number; canada?: boolean }) => {
    const sp = new URLSearchParams();
    if (o.q ?? q) sp.set("q", o.q ?? q);
    if (o.canada ?? fromCanada) sp.set("from", "CA");
    if ((o.page ?? 1) > 1) sp.set("page", String(o.page));
    const qs = sp.toString();
    return `/search${qs ? `?${qs}` : ""}`;
  };
  const pageHref = (n: number) => href({ page: n });

  return (
    <>
      <section className="band band-dark search-hero">
        <div className="wrap">
          <p className="eyebrow">{fromCanada ? "🇨🇦 Ships from Canada" : "Search everything"}</p>
          <h1 className="section-title">{fromCanada ? `In stock in Canada. Delivered in ${CANADA_DAYS}.` : "Find any product. See your price and shipping."}</h1>
          <form className="search-big" role="search" action="/search">
            <label className="sr-only" htmlFor="search-q">
              Search products
            </label>
            <input id="search-q" name="q" type="search" defaultValue={q} placeholder={fromCanada ? "Search the Canadian warehouse" : "Try “cordless drill” or “socket set”"} autoFocus={!q && !fromCanada} />
            {fromCanada && <input type="hidden" name="from" value="CA" />}
            <button className="btn primary lg">Search</button>
          </form>
          <div className="search-scope" role="group" aria-label="Where it ships from">
            <Link href={href({ canada: false, page: 1 })} className={!fromCanada ? "on" : ""} aria-pressed={!fromCanada}>
              All warehouses
            </Link>
            <Link href={href({ canada: true, page: 1 })} className={fromCanada ? "on" : ""} aria-pressed={fromCanada}>
              🇨🇦 Ships from Canada · {CANADA_DAYS}
            </Link>
          </div>
          {!q && !fromCanada && (
            <div className="search-ideas">
              {IDEAS.map((i) => (
                <Link key={i} href={`/search?q=${encodeURIComponent(i)}`}>
                  {i}
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {browsing && (
        <section className="band band-search">
          <div className="wrap">
            {failed ? (
              <p className="notice err">Search is busy right now. Please try again in a moment.</p>
            ) : hits.length === 0 ? (
              <div className="empty">
                <p className="big">{q ? `No results for “${q}”${fromCanada ? " in the Canadian warehouse" : ""}.` : "Nothing in the Canadian warehouse right now."}</p>
                <p className="muted">
                  {fromCanada ? (
                    <>
                      CJ’s Canadian range is still small. <Link href={href({ canada: false, page: 1 })}>Search all warehouses</Link> (ships from China in 1–3 weeks).
                    </>
                  ) : (
                    "Try a simpler word, like “lantern” instead of “rechargeable camping lantern light”."
                  )}
                </p>
              </div>
            ) : (
              <>
                <ShipCountryBar country={(await getShipTo()).country} countries={SHIP_COUNTRIES} />
                <p className="muted small search-count">
                  {total != null ? `${total.toLocaleString("en-US")} results` : `${hits.length} results`}
                  {q ? ` for “${q}”` : ""}
                  {fromCanada ? " in stock in Canada" : ""}
                  {page > 1 ? ` · page ${page}` : ""}. Prices include everything but shipping; each product shows whether it ships to you.
                </p>
                <div className="pgrid">
                  {hits.map((h) => (
                    <Link key={h.pid} href={`/search/item/${encodeURIComponent(h.pid)}`} className="pcard" rel="nofollow" prefetch={false}>
                      <div className="pcard-media">
                        <img src={`/media/s/${encodeURIComponent(h.pid)}`} alt="" loading="lazy" />
                      </div>
                      <div className="pcard-body">
                        <h3 className="pcard-title">{h.title}</h3>
                        <ShipBadge pid={h.pid} className="pcard-ship" />
                        <div className="pcard-foot">
                          <span className="pcard-price">
                            <span className="from">From </span>
                            {formatMoney(h.fromCents)}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
                <nav className="pager" aria-label="Pages">
                  {page > 1 ? <Link href={pageHref(page - 1)}>← Previous</Link> : <span />}
                  {more && <Link href={pageHref(page + 1)}>Next →</Link>}
                </nav>
              </>
            )}
          </div>
        </section>
      )}
    </>
  );
}
