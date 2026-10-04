import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Flash } from "@/components/admin";
import { drawBox, loadPool, simulate } from "@/lib/mystery";
import { deleteBoxAction, removePoolItemAction, setBoxStatusAction } from "@/app/admin/actions";

export const dynamic = "force-dynamic";

export default async function BoxDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { id } = await params;
  const { notice, error } = await searchParams;
  const box = await prisma.mysteryBox.findUnique({
    where: { id },
    include: { pool: { include: { variant: { include: { product: { include: { images: { take: 1, orderBy: { position: "asc" } } } }, offer: { include: { cjSupplierVariant: true } } } } } } },
  });
  if (!box) notFound();
  const pool = await loadPool(box.id);
  const stats = simulate(pool, box);
  const sample = drawBox(pool, box);
  const live = box.status === "PUBLISHED";

  return (
    <>
      <Link href="/admin/boxes" className="a-back">
        ‹ Mystery boxes
      </Link>
      <div className="a-head">
        <div>
          <h1>{box.name}</h1>
          <div className="a-sub">{box.tagline}</div>
        </div>
        <span className={`chip-status ${live ? "tone-good" : "tone-muted"}`}>{live ? "Live" : "Draft"}</span>
      </div>
      <Flash notice={notice} error={error} />

      <section className="a-card money-row" aria-label="Box numbers">
        <div>
          <div className="k">Price</div>
          <div className="v">{formatMoney(box.priceCents)}</div>
        </div>
        <div>
          <div className="k">Guaranteed value</div>
          <div className="v">{formatMoney(box.guaranteedValueCents)}+</div>
        </div>
        <div>
          <div className="k">Avg profit</div>
          <div className={`v ${stats.avgProfitCents > 0 ? "pos" : "neg"}`}>{stats.avgProfitCents ? formatMoney(stats.avgProfitCents) : "—"}</div>
        </div>
      </section>

      <section className="a-card">
        <h2 className="a-h2">Health</h2>
        <p className="small">
          <strong>{Math.round(stats.successRate * 100)}%</strong> of test draws meet every rule ({box.itemCount} different in-stock items, worth at least{" "}
          {formatMoney(box.guaranteedValueCents)}, at least {formatMoney(box.minProfitCents)} profit). {stats.inStockProducts} products in stock. Average box worth{" "}
          {formatMoney(stats.avgValueCents)}.
        </p>
        {stats.successRate < 0.9 && (
          <p className="notice err small">
            This pool can’t reliably make boxes. Design it again with a lower guaranteed value, more items or a broader brief before publishing.
          </p>
        )}
        <p className="muted small">{box.buildLog}</p>
        <div className="email-list-actions">
          <form action={setBoxStatusAction}>
            <input type="hidden" name="id" value={box.id} />
            <input type="hidden" name="status" value={live ? "DRAFT" : "PUBLISHED"} />
            <button className={`a-btn ${live ? "" : "a-btn-primary"}`} disabled={!live && stats.successRate < 0.9}>
              {live ? "Unpublish" : "Publish to the store"}
            </button>
          </form>
          {live && (
            <Link href={`/boxes/${box.slug}`} className="a-btn" target="_blank">
              View in store ↗
            </Link>
          )}
        </div>
      </section>

      {sample && (
        <section className="a-card">
          <h2 className="a-h2">A sample draw (refresh for another)</h2>
          <ul className="mini-list">
            {sample.map((v) => (
              <li key={v.variantId}>
                <div className="mini-row">
                  <span className="strong">{v.title}</span>
                  <span className="muted small">
                    list {formatMoney(v.listCents)} · cost {formatMoney(v.costCents)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="small">
            Worth {formatMoney(sample.reduce((n, v) => n + v.listCents, 0))} · costs you {formatMoney(sample.reduce((n, v) => n + v.costCents, 0))} · profit{" "}
            {formatMoney(box.priceCents - sample.reduce((n, v) => n + v.costCents, 0))} (shipping is paid by the buyer)
          </p>
        </section>
      )}

      <section className="a-card">
        <h2 className="a-h2">Pool ({box.pool.length} options)</h2>
        <ul className="product-list">
          {box.pool.map((p) => {
            const v = p.variant;
            const img = v.product.images[0];
            return (
              <li key={p.id} className="pool-row">
                <div className="product-thumb">{img ? <img src={`/media/${img.id}`} alt="" loading="lazy" /> : <span />}</div>
                <div className="product-main">
                  <div className="product-title">{v.product.title}</div>
                  <div className="muted small">
                    {v.name} · list {formatMoney(v.priceCents)} · cost {formatMoney(v.offer?.cjSupplierVariant.supplierPriceCents)} · stock {v.offer?.cjSupplierVariant.inventoryTotal ?? "?"}
                  </div>
                </div>
                <form action={removePoolItemAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="boxId" value={box.id} />
                  <button className="a-btn a-btn-sm a-btn-ghost">Remove</button>
                </form>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="a-card">
        <h2 className="a-h2">Brief</h2>
        <p className="small">{box.brief}</p>
        <p className="small">{box.description}</p>
        <form action={deleteBoxAction}>
          <input type="hidden" name="id" value={box.id} />
          <button className="a-btn a-btn-sm a-btn-ghost danger-text">Delete box</button>
        </form>
      </section>
    </>
  );
}
