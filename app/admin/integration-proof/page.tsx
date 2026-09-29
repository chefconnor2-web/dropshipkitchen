import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { stockLabel, stockStatus } from "@/lib/inventory";
import { warehouseSummary } from "@/lib/cj/normalize";
import { CjStatusPanel, Flash, Source, fmtTime } from "@/components/admin";
import { refreshVariantLive } from "@/app/admin/actions";

export default async function IntegrationProof({
  searchParams,
}: {
  searchParams: Promise<{ product?: string; variant?: string; error?: string }>;
}) {
  const { product: productId, variant: variantId, error } = await searchParams;
  const products = await prisma.product.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, status: true },
  });
  const product = await prisma.product.findUnique({
    where: { id: productId ?? products[0]?.id ?? "" },
    include: { variants: { orderBy: { position: "asc" }, include: { offer: { include: { cjSupplierVariant: true } } } } },
  });
  const variant = product?.variants.find((v) => v.id === variantId) ?? product?.variants[0];
  const sv = variant?.offer?.cjSupplierVariant;
  const lastCall = sv
    ? await prisma.cjApiCall.findFirst({
        where: { path: "/product/stock/queryByVid", query: `vid=${encodeURIComponent(sv.cjVariantId)}`, ok: true },
        orderBy: { createdAt: "desc" },
      })
    : null;
  const back = product ? `/admin/integration-proof?product=${product.id}${variant ? `&variant=${variant.id}` : ""}` : "/admin/integration-proof";
  const status = stockStatus(sv?.inventoryTotal);
  const warehouses = warehouseSummary(sv?.inventoryJson ? JSON.parse(sv.inventoryJson) : null);

  return (
    <>
      <h1>Integration proof</h1>
      <p className="muted">
        Follows one storefront variant through the SupplierOffer mapping to the exact CJ variant, and re-reads it from CJ&apos;s
        official API on demand.
      </p>
      <Flash error={error} />
      <CjStatusPanel back={back} />

      {products.length === 0 ? (
        <p className="notice">
          No products imported yet. <Link href="/admin/suppliers/cj">Search &amp; import from CJ →</Link>
        </p>
      ) : (
        <form className="row gap" method="get">
          <select name="product" defaultValue={product?.id}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.status})
              </option>
            ))}
          </select>
          <button className="btn">Choose product</button>
        </form>
      )}

      {product && (
        <form className="row gap" method="get">
          <input type="hidden" name="product" value={product.id} />
          <select name="variant" defaultValue={variant?.id}>
            {product.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <button className="btn">Choose variant</button>
        </form>
      )}

      {product && variant && (
        <div className="chain">
          <div className="node ours">
            <Source kind="ours" />
            <div className="node-title">CHEF SUPPLY PRODUCT</div>
            <div className="big">{product.title}</div>
            <div>{formatMoney(variant.priceCents)}</div>
            <div className="small muted">
              Internal SKU <code>{product.internalSku}</code> · {product.status} ·{" "}
              {product.status === "PUBLISHED" && (
                <Link href={`/products/${product.slug}`} target="_blank">
                  /products/{product.slug} ↗
                </Link>
              )}
            </div>
          </div>
          <div className="arrow">↓</div>
          <div className="node ours">
            <Source kind="ours" />
            <div className="node-title">INTERNAL VARIANT</div>
            <div className="big">{variant.name}</div>
            <div className="small muted">
              ProductVariant <code>{variant.id}</code> · SKU <code>{variant.internalSku}</code>
            </div>
          </div>
          <div className="arrow">↓</div>
          <div className="node mapping">
            <div className="node-title">SUPPLIER MAPPING (SupplierOffer)</div>
            {variant.offer ? (
              <dl className="kv">
                <dt>Supplier</dt>
                <dd>{variant.offer.supplier}</dd>
                <dt>PID</dt>
                <dd>
                  <code>{variant.offer.supplierProductId}</code>
                </dd>
                <dt>VID</dt>
                <dd>
                  <code>{variant.offer.supplierVariantId}</code>
                </dd>
                <dt>SKU</dt>
                <dd>
                  <code>{variant.offer.supplierSku}</code>
                </dd>
              </dl>
            ) : (
              <p className="err-text">UNMAPPED</p>
            )}
          </div>
          <div className="arrow">↓</div>
          <div className="node live">
            <Source kind="live" />
            <div className="node-title">LIVE CJ DATA</div>
            {sv ? (
              <>
                <dl className="kv">
                  <dt>Supplier price</dt>
                  <dd>{formatMoney(sv.supplierPriceCents)}</dd>
                  <dt>Inventory</dt>
                  <dd>{sv.inventoryTotal ?? "unknown"}</dd>
                  <dt>Warehouse</dt>
                  <dd>{warehouses.length ? warehouses.map((w) => `${w.label}: ${w.qty ?? "?"}`).join(" · ") : "—"}</dd>
                </dl>
                <p className="small">
                  Last verified from CJ: <strong>{fmtTime(sv.inventoryCheckedAt)}</strong>
                  {lastCall?.requestId && (
                    <>
                      {" "}
                      · CJ requestId <code>{lastCall.requestId}</code>
                    </>
                  )}
                  <br />
                  Price verified: {fmtTime(sv.priceCheckedAt)}
                </p>
                <form action={refreshVariantLive}>
                  <input type="hidden" name="cjSupplierVariantId" value={sv.id} />
                  <input type="hidden" name="back" value={back} />
                  <button className="btn primary">REFRESH LIVE DATA</button>
                </form>
                <p className="small muted">
                  Calls GET /product/variant/queryByVid and GET /product/stock/queryByVid with vid={sv.cjVariantId}
                </p>
              </>
            ) : (
              <p>—</p>
            )}
          </div>
          <div className="arrow">↓</div>
          <div className="node ours">
            <Source kind="ours" />
            <div className="node-title">CUSTOMER PRODUCT (what the shopper sees)</div>
            <div className={`big stock stock-${status}`}>{stockLabel(status).toUpperCase()}</div>
            <div className="big">{formatMoney(variant.priceCents)}</div>
            <div className="small muted">No supplier name, SKU, price or unit count is sent to the browser.</div>
          </div>
        </div>
      )}
    </>
  );
}
