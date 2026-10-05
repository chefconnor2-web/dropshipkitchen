import Link from "next/link";
import { config } from "@/lib/config";
import { cjConfigured } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { PAGE_SIZE, searchCatalog, type CatalogHit } from "@/lib/catalog-search";
import { getShipTo } from "@/lib/cart";
import { SHIP_COUNTRIES } from "@/lib/countries";
import ShipBadge from "@/components/ShipBadge";
import ShipCountryBar from "@/components/ShipCountryBar";

export const dynamic = "force-dynamic";
export const metadata = { title: `Search — ${config.storeName}`, robots: { index: false, follow: false } };

const IDEAS = ["cordless drill", "angle grinder", "socket set", "laser level", "multimeter", "work light", "screwdriver", "battery adapter"];

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const params = await searchParams;
  const q = (params.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Math.min(50, Number(params.page) || 1));
  let hits: CatalogHit[] = [];
  let total: number | null = null;
  let failed = false;
  if (q && cjConfigured()) {
    try {
      ({ hits, total } = await searchCatalog(q, page));
    } catch {
      failed = true;
    }
  }
  const more = total != null ? page * PAGE_SIZE < total : hits.length > 0;
  const pageHref = (n: number) => `/search?q=${encodeURIComponent(q)}${n > 1 ? `&page=${n}` : ""}`;

  return (
    <>
      <section className="band band-dark search-hero">
        <div className="wrap">
          <p className="eyebrow">Search everything</p>
          <h1 className="section-title">Find any product. See your price and shipping.</h1>
          <form className="search-big" role="search" action="/search">
            <label className="sr-only" htmlFor="search-q">
              Search products
            </label>
            <input id="search-q" name="q" type="search" defaultValue={q} placeholder="Try “cordless drill” or “socket set”" autoFocus={!q} />
            <button className="btn primary lg">Search</button>
          </form>
          {!q && (
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

      {q && (
        <section className="band band-search">
          <div className="wrap">
            {failed ? (
              <p className="notice err">Search is busy right now. Please try again in a moment.</p>
            ) : hits.length === 0 ? (
              <div className="empty">
                <p className="big">No results for “{q}”.</p>
                <p className="muted">Try a simpler word, like “lantern” instead of “rechargeable camping lantern light”.</p>
              </div>
            ) : (
              <>
                <ShipCountryBar country={(await getShipTo()).country} countries={SHIP_COUNTRIES} />
                <p className="muted small search-count">
                  {total != null ? `${total.toLocaleString("en-US")} results` : `${hits.length} results`} for “{q}”
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
