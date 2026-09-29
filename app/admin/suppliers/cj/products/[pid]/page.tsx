import Link from "next/link";
import { getProductDetail, getStockByVid } from "@/lib/cj/client";
import { normalizeVariant, productImages, productName, sumInventory, warehouseSummary } from "@/lib/cj/normalize";
import { formatMoney } from "@/lib/money";
import { prisma } from "@/lib/db";
import { Flash, Source, fmtTime } from "@/components/admin";
import { importProduct } from "@/app/admin/actions";

// Live view of one CJ product straight from GET /product/query (nothing here is read from our DB).
export default async function CjProductView({
  params,
  searchParams,
}: {
  params: Promise<{ pid: string }>;
  searchParams: Promise<{ dc?: string; stock?: string; error?: string }>;
}) {
  const { pid } = await params;
  const { dc, stock, error } = await searchParams;
  let detailEnv;
  try {
    detailEnv = await getProductDetail(pid);
  } catch (e) {
    return (
      <>
        <Link href="/admin/suppliers/cj">← Back to search</Link>
        <p className="notice err">CJ product/query failed: {e instanceof Error ? e.message : String(e)}</p>
      </>
    );
  }
  const d = detailEnv.data;
  const variants = (d.variants ?? []).map((v) => ({ raw: v, n: normalizeVariant(v) }));
  const images = productImages(d);

  // Optional live stock for the first variants (one CJ call per VID, so opt-in).
  const stockByVid = new Map<string, ReturnType<typeof warehouseSummary> & { total?: number | null }>();
  const stockTotals = new Map<string, number | null>();
  if (stock === "1") {
    for (const { n } of variants.slice(0, 15)) {
      try {
        const s = await getStockByVid(n.cjVariantId);
        stockByVid.set(n.cjVariantId, warehouseSummary(s.data));
        stockTotals.set(n.cjVariantId, sumInventory(s.data));
      } catch {
        stockTotals.set(n.cjVariantId, null);
      }
    }
  }
  const existing = await prisma.cjSupplierProduct.findUnique({
    where: { cjProductId: d.pid },
    select: { products: { select: { id: true } } },
  });
  const back = `/admin/suppliers/cj/products/${encodeURIComponent(pid)}`;

  return (
    <>
      <Link href="/admin/suppliers/cj">← Back to search</Link>
      <Flash error={error} />
      <h1>{productName(d)}</h1>
      <p className="small">
        <Source kind="live" /> GET /product/query?pid={d.pid} · fetched {fmtTime(new Date())}
        {detailEnv.requestId && (
          <>
            {" "}
            · CJ requestId <code>{detailEnv.requestId}</code>
          </>
        )}
      </p>
      <div className="row gap">
        <form action={importProduct}>
          <input type="hidden" name="pid" value={d.pid} />
          <input type="hidden" name="deliveryCycle" value={dc ?? ""} />
          <input type="hidden" name="back" value={back} />
          <button className="btn primary">{existing ? "Re-sync import" : "Import product"}</button>
        </form>
        {existing?.products[0] && <Link href={`/admin/products/${existing.products[0].id}`}>Edit storefront product →</Link>}
        {stock !== "1" && (
          <Link className="btn" href={`${back}?stock=1&dc=${encodeURIComponent(dc ?? "")}`}>
            Load live inventory per variant
          </Link>
        )}
      </div>
      <dl className="kv">
        <dt>CJ PID</dt>
        <dd>
          <code>{d.pid}</code>
        </dd>
        <dt>CJ product SKU</dt>
        <dd>
          <code>{d.productSku}</code>
        </dd>
        <dt>Category</dt>
        <dd>{String(d.categoryName ?? "—")}</dd>
        <dt>Option keys</dt>
        <dd>{d.productKeyEn ?? "—"}</dd>
        <dt>Weight</dt>
        <dd>{d.productWeight ? `${d.productWeight} g` : "—"}</dd>
        <dt>Delivery cycle</dt>
        <dd>{dc ? `${dc} days (from listV2)` : "—"}</dd>
      </dl>
      <div className="img-strip">
        {images.slice(0, 10).map((u) => (
          <img key={u} src={u} alt="" loading="lazy" />
        ))}
      </div>
      <h2>Variants ({variants.length})</h2>
      <table className="table small">
        <thead>
          <tr>
            <th></th>
            <th>CJ VID</th>
            <th>CJ variant SKU</th>
            <th>variantKey / name</th>
            <th>Supplier price</th>
            <th>Weight</th>
            <th>L×W×H</th>
            <th>Inventory</th>
          </tr>
        </thead>
        <tbody>
          {variants.map(({ n }) => (
            <tr key={n.cjVariantId}>
              <td>{n.variantImage && <img className="thumb" src={n.variantImage} alt="" loading="lazy" />}</td>
              <td>
                <code>{n.cjVariantId}</code>
              </td>
              <td>
                <code>{n.cjVariantSku}</code>
              </td>
              <td>
                {n.variantKey}
                <div className="muted">{n.variantName}</div>
              </td>
              <td>{formatMoney(n.supplierPriceCents)}</td>
              <td>{n.weightGrams ?? "—"} g</td>
              <td>{[n.lengthMm, n.widthMm, n.heightMm].map((x) => x ?? "?").join("×")}</td>
              <td>
                {stockTotals.has(n.cjVariantId) ? (
                  <>
                    {stockTotals.get(n.cjVariantId) ?? "error"}
                    <div className="muted">
                      {(stockByVid.get(n.cjVariantId) ?? []).map((w) => `${w.label}: ${w.qty ?? "?"}`).join(", ")}
                    </div>
                  </>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.description && (
        <details className="raw">
          <summary>CJ description (supplier copy — not shown to customers as-is)</summary>
          <pre className="wrap-pre">{String(d.description).replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ")}</pre>
        </details>
      )}
      <details className="raw">
        <summary>Raw CJ product/query response (unmodified)</summary>
        <pre>{JSON.stringify(d, null, 2)}</pre>
      </details>
    </>
  );
}
