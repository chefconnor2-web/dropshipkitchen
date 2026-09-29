import Link from "next/link";
import { prisma } from "@/lib/db";
import { cjConfigured } from "@/lib/config";
import { listProductsV2 } from "@/lib/cj/client";
import { parseListV2, type SearchResult } from "@/lib/cj/normalize";
import { CjStatusPanel, Flash, Source, fmtTime } from "@/components/admin";
import { importProduct } from "@/app/admin/actions";

const SUGGESTIONS = ["chef", "kitchen", "tweezers", "thermometer", "knife", "pastry", "spatula", "squeeze bottle", "bench scraper", "measuring"];

export default async function CjPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; error?: string; notice?: string }>;
}) {
  const { q = "", page = "1", error, notice } = await searchParams;
  const pageNum = Math.max(1, Number(page) || 1);
  let results: SearchResult[] = [];
  let total: number | null = null;
  let searchError: string | null = null;
  let raw: unknown = null;
  let fetchedAt: Date | null = null;
  let requestId: string | undefined;

  if (q && cjConfigured()) {
    try {
      const env = await listProductsV2(q, pageNum, 20);
      fetchedAt = new Date();
      requestId = env.requestId;
      raw = env.data;
      ({ items: results, total } = parseListV2(env.data));
    } catch (e) {
      searchError = e instanceof Error ? e.message : String(e);
    }
  }
  const imported = new Map(
    (
      await prisma.cjSupplierProduct.findMany({
        where: { cjProductId: { in: results.map((r) => r.pid) } },
        select: { cjProductId: true, products: { select: { id: true } } },
      })
    ).map((s) => [s.cjProductId, s.products[0]?.id]),
  );
  const back = `/admin/suppliers/cj?q=${encodeURIComponent(q)}&page=${pageNum}`;

  return (
    <>
      <h1>CJdropshipping integration</h1>
      <Flash notice={notice} error={error} />
      <CjStatusPanel back={back} />

      <h2>Search CJ products</h2>
      <form className="row gap" method="get">
        <input name="q" defaultValue={q} placeholder="e.g. plating tweezers" className="grow" />
        <button className="btn primary">Search CJ</button>
      </form>
      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <Link key={s} href={`/admin/suppliers/cj?q=${encodeURIComponent(s)}`} className="chip">
            {s}
          </Link>
        ))}
      </div>

      {searchError && <p className="notice err">CJ search failed: {searchError}</p>}
      {q && !cjConfigured() && <p className="notice err">Set CJ_API_KEY to search the live CJ catalog.</p>}

      {fetchedAt && (
        <p className="small">
          <Source kind="live" /> GET /product/listV2 · keyWord “{q}” · page {pageNum} · {results.length} shown
          {total !== null && ` of ${total}`} · fetched {fmtTime(fetchedAt)}
          {requestId && (
            <>
              {" "}
              · CJ requestId <code>{requestId}</code>
            </>
          )}
        </p>
      )}

      <div className="results">
        {results.map((r) => (
          <div key={r.pid} className="card result">
            {r.image ? <img src={r.image} alt="" loading="lazy" /> : <div className="img-ph" />}
            <div className="pad grow">
              <div className="strong">{r.name}</div>
              <dl className="kv small">
                <dt>CJ PID</dt>
                <dd>
                  <code>{r.pid}</code>
                </dd>
                <dt>CJ SKU</dt>
                <dd>
                  <code>{r.sku ?? "—"}</code>
                </dd>
                <dt>Supplier price</dt>
                <dd>{r.priceLabel ? `$${r.priceLabel}` : "—"}</dd>
                <dt>Inventory</dt>
                <dd>{r.inventory ?? "see product"}</dd>
                <dt>Delivery cycle</dt>
                <dd>{r.deliveryCycle ? `${r.deliveryCycle} days` : "—"}</dd>
                <dt>Category</dt>
                <dd>{r.category ?? "—"}</dd>
                <dt>Variants</dt>
                <dd>listed on View Product (from product/query)</dd>
              </dl>
              <div className="row gap">
                <Link className="btn" href={`/admin/suppliers/cj/products/${encodeURIComponent(r.pid)}?dc=${encodeURIComponent(r.deliveryCycle ?? "")}`}>
                  View product
                </Link>
                <form action={importProduct}>
                  <input type="hidden" name="pid" value={r.pid} />
                  <input type="hidden" name="deliveryCycle" value={r.deliveryCycle ?? ""} />
                  <input type="hidden" name="back" value={back} />
                  <button className="btn primary">{imported.has(r.pid) ? "Re-sync import" : "Import product"}</button>
                </form>
                {imported.get(r.pid) && (
                  <Link href={`/admin/products/${imported.get(r.pid)}`} className="small">
                    Imported → edit
                  </Link>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {fetchedAt && results.length === 0 && <p className="muted">CJ returned no products for “{q}”.</p>}
      {fetchedAt && (
        <div className="row gap">
          {pageNum > 1 && (
            <Link className="btn" href={`/admin/suppliers/cj?q=${encodeURIComponent(q)}&page=${pageNum - 1}`}>
              ← Prev
            </Link>
          )}
          {results.length === 20 && (
            <Link className="btn" href={`/admin/suppliers/cj?q=${encodeURIComponent(q)}&page=${pageNum + 1}`}>
              Next →
            </Link>
          )}
        </div>
      )}
      {raw !== null && (
        <details className="raw">
          <summary>Raw CJ listV2 response (unmodified)</summary>
          <pre>{JSON.stringify(raw, null, 2)}</pre>
        </details>
      )}
      <p className="muted small">Formatted prices in search are CJ list prices; per-variant prices come from the product detail.</p>
    </>
  );
}
