import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { stockLabel, stockStatus, isStale } from "@/lib/inventory";
import { warehouseSummary } from "@/lib/cj/normalize";
import { Flash, Source, fmtTime } from "@/components/admin";
import { addImage, importProduct, refreshVariantLive, removeImage, saveProduct, setPublished } from "@/app/admin/actions";

export default async function EditProduct({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { id } = await params;
  const { notice, error } = await searchParams;
  const p = await prisma.product.findUnique({
    where: { id },
    include: {
      images: { orderBy: { position: "asc" } },
      variants: { orderBy: { position: "asc" }, include: { offer: { include: { cjSupplierVariant: true } } } },
      supplierProduct: true,
    },
  });
  if (!p) notFound();
  const sp = p.supplierProduct;
  const back = `/admin/products/${p.id}`;

  return (
    <>
      <Link href="/admin/products">← Products</Link>
      <Flash notice={notice} error={error} />
      <div className="row between">
        <h1>{p.title}</h1>
        <div className="row gap">
          <span className={`pill ${p.status === "PUBLISHED" ? "pill-ok" : ""}`}>{p.status}</span>
          <form action={setPublished}>
            <input type="hidden" name="id" value={p.id} />
            <input type="hidden" name="publish" value={p.status === "PUBLISHED" ? "0" : "1"} />
            <button className={`btn ${p.status === "PUBLISHED" ? "" : "primary"}`}>
              {p.status === "PUBLISHED" ? "Unpublish" : "Publish"}
            </button>
          </form>
          {p.status === "PUBLISHED" && (
            <Link className="btn" href={`/products/${p.slug}`} target="_blank">
              View in store ↗
            </Link>
          )}
          <Link className="btn" href={`/admin/integration-proof?product=${p.id}`}>
            Integration proof
          </Link>
        </div>
      </div>

      <form action={saveProduct} id="save">
        <input type="hidden" name="id" value={p.id} />
      </form>

      <div className="two-col">
        <section className="card pad">
          <Source kind="ours" />
          <label>
            Our title
            <input form="save" name="title" defaultValue={p.title} required />
          </label>
          <label>
            URL slug
            <input form="save" name="slug" defaultValue={p.slug} />
          </label>
          <label>
            Internal SKU
            <input form="save" name="internalSku" defaultValue={p.internalSku} required />
          </label>
          <label>
            Our description
            <textarea form="save" name="description" rows={8} defaultValue={p.description} />
          </label>
          <label>
            Categories (comma separated)
            <input form="save" name="categories" defaultValue={p.categories} placeholder="Plating, Tweezers" />
          </label>
          <label>
            Estimated delivery (shown to customers)
            <input form="save" name="estimatedDelivery" defaultValue={p.estimatedDelivery ?? ""} placeholder="7–12 business days" />
          </label>
          <label>
            SEO title
            <input form="save" name="seoTitle" defaultValue={p.seoTitle ?? ""} />
          </label>
          <label>
            SEO description
            <textarea form="save" name="seoDescription" rows={2} defaultValue={p.seoDescription ?? ""} />
          </label>
          <div className="small muted">Our images (served to customers via our own /media URLs)</div>
          <div className="img-strip">
            {p.images.map((img) => (
              <form key={img.id} action={removeImage} className="img-tile">
                <img src={`/media/${img.id}`} alt="" />
                <input type="hidden" name="imageId" value={img.id} />
                <button className="btn tiny" title="Remove image">
                  ✕
                </button>
              </form>
            ))}
          </div>
          <form action={addImage} className="row gap">
            <input type="hidden" name="productId" value={p.id} />
            <input name="url" placeholder="Add our own image (https://…)" className="grow" />
            <button className="btn">Add</button>
          </form>
        </section>

        <section className="card pad supplier">
          <Source kind="cached" />
          {sp ? (
            <>
              <dl className="kv">
                <dt>Supplier</dt>
                <dd>CJdropshipping</dd>
                <dt>CJ product name</dt>
                <dd>{sp.cjProductName}</dd>
                <dt>CJ PID</dt>
                <dd>
                  <code>{sp.cjProductId}</code>
                </dd>
                <dt>CJ product SKU</dt>
                <dd>
                  <code>{sp.cjProductSku}</code>
                </dd>
                <dt>CJ category</dt>
                <dd>{sp.cjCategoryName ?? "—"}</dd>
                <dt>CJ weight</dt>
                <dd>{sp.cjProductWeight ? `${sp.cjProductWeight} g` : "—"}</dd>
                <dt>CJ delivery cycle</dt>
                <dd>{sp.cjDeliveryCycle ? `${sp.cjDeliveryCycle} days` : "—"}</dd>
                <dt>Last synced</dt>
                <dd>{fmtTime(sp.lastSyncedAt)}</dd>
              </dl>
              <div className="row gap">
                <form action={importProduct}>
                  <input type="hidden" name="pid" value={sp.cjProductId} />
                  <input type="hidden" name="back" value={back} />
                  <button className="btn">Re-sync from CJ</button>
                </form>
                <Link className="btn" href={`/admin/suppliers/cj/products/${encodeURIComponent(sp.cjProductId)}`}>
                  View live on CJ API
                </Link>
              </div>
              <div className="img-strip">
                {(JSON.parse(sp.cjImages) as string[]).slice(0, 6).map((u) => (
                  <img key={u} src={u} alt="" loading="lazy" />
                ))}
              </div>
              {sp.cjDescription && (
                <details>
                  <summary className="small">CJ description (supplier copy)</summary>
                  <pre className="wrap-pre small">{sp.cjDescription.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ")}</pre>
                </details>
              )}
            </>
          ) : (
            <p className="muted">No supplier record linked.</p>
          )}
        </section>
      </div>

      <h2>Variants → exact CJ variant mapping</h2>
      <p className="muted small">
        Each storefront variant is backed by exactly one real CJ variant (VID). Options came from CJ&apos;s own variant keys.
      </p>
      <table className="table small">
        <thead>
          <tr>
            <th colSpan={4}>
              <Source kind="ours" />
            </th>
            <th colSpan={5}>
              <Source kind="cached" />
            </th>
            <th></th>
          </tr>
          <tr>
            <th>On</th>
            <th>Our variant name</th>
            <th>Our SKU</th>
            <th>Our price</th>
            <th>CJ VID</th>
            <th>CJ variant SKU</th>
            <th>CJ price</th>
            <th>CJ inventory</th>
            <th>Margin</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {p.variants.map((v) => {
            const sv = v.offer?.cjSupplierVariant;
            const margin = sv?.supplierPriceCents != null ? v.priceCents - sv.supplierPriceCents : null;
            const wh = warehouseSummary(sv?.inventoryJson ? JSON.parse(sv.inventoryJson) : null);
            return (
              <tr key={v.id} className={v.enabled ? "" : "dim"}>
                <td>
                  <input form="save" type="checkbox" name={`enabled_${v.id}`} defaultChecked={v.enabled} />
                </td>
                <td>
                  <input form="save" name={`name_${v.id}`} defaultValue={v.name} />
                </td>
                <td>
                  <code>{v.internalSku}</code>
                </td>
                <td>
                  <input form="save" className="price-input" name={`price_${v.id}`} defaultValue={(v.priceCents / 100).toFixed(2)} />
                </td>
                <td>
                  <code>{v.offer?.supplierVariantId ?? "UNMAPPED"}</code>
                </td>
                <td>
                  <code>{v.offer?.supplierSku ?? "—"}</code>
                </td>
                <td>{formatMoney(sv?.supplierPriceCents)}</td>
                <td>
                  {sv?.inventoryTotal ?? "—"} <span className="muted">({stockLabel(stockStatus(sv?.inventoryTotal))})</span>
                  <div className="muted">
                    {wh.map((w) => `${w.label}: ${w.qty ?? "?"}`).join(", ")}
                    {sv && (
                      <>
                        <br />
                        checked {fmtTime(sv.inventoryCheckedAt)}
                        {isStale(sv.inventoryCheckedAt) && " (stale)"}
                      </>
                    )}
                  </div>
                </td>
                <td>
                  {margin !== null ? (
                    <span className={margin > 0 ? "ok-text" : "err-text"}>{formatMoney(margin)}</span>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {sv && (
                    <form action={refreshVariantLive}>
                      <input type="hidden" name="cjSupplierVariantId" value={sv.id} />
                      <input type="hidden" name="back" value={back} />
                      <button className="btn tiny">Refresh live</button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">Margin shown excludes shipping, which CJ quotes at order confirmation.</p>
      <div className="sticky-save">
        <button form="save" className="btn primary">
          Save storefront data
        </button>
      </div>
    </>
  );
}
