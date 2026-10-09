// Admin › Gifts › Find a bottle: real drinkware from CJ's live catalog, by style, each shown as CJ's own product
// photo with your logo printed on the bottle (only listings where that works are shown). Import adds it to the store; turn on photo
// personalization on the product and it shows up in Gifts.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { cjConfigured } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { BOTTLE_TYPES, findBottles, type BottleType, type FoundBottle } from "@/lib/bottle-finder";
import { GIFT_DESIGNS, type GiftDesign } from "@/lib/gifts";
import { importProduct } from "@/app/admin/actions";

export const dynamic = "force-dynamic";

export default async function BottleFinder({ searchParams }: { searchParams: Promise<{ type?: string; design?: string; error?: string }> }) {
  const sp = await searchParams;
  const type = (BOTTLE_TYPES.some((t) => t.id === sp.type) ? sp.type : "tumbler") as BottleType;
  const design = (sp.design && sp.design in GIFT_DESIGNS ? sp.design : "mascot") as GiftDesign;
  let items: FoundBottle[] = [];
  let problem: string | null = null;
  if (!cjConfigured()) problem = "Set CJ_API_KEY to search CJ's live catalog.";
  else
    try {
      items = await findBottles(type);
    } catch (e) {
      problem = `CJ search failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  const imported = new Map(
    (await prisma.cjSupplierProduct.findMany({ where: { cjProductId: { in: items.map((i) => i.pid) } }, select: { cjProductId: true, products: { select: { id: true }, take: 1 } } })).map((s) => [
      s.cjProductId,
      s.products[0]?.id,
    ]),
  );
  const qs = (t: string, d: string) => `/admin/gifts/bottles?type=${t}&design=${d}`;
  const back = qs(type, design);
  return (
    <>
      <div className="a-head">
        <div>
          <h1>Find a bottle on CJ</h1>
          <div className="a-sub">
            Real products from CJ’s live catalog, each shown with your logo printed on the bottle in CJ’s own photo. Import one, turn on photo personalization on it, and it appears in{" "}
            <Link href="/admin/gifts">Gifts</Link>.
          </div>
        </div>
      </div>
      {sp.error && <p className="notice err">{sp.error}</p>}
      <div className="bf-bar">
        <div className="chips" role="tablist" aria-label="Bottle style">
          {BOTTLE_TYPES.map((t) => (
            <Link key={t.id} href={qs(t.id, design)} className={`chip${t.id === type ? " on" : ""}`} aria-current={t.id === type ? "page" : undefined}>
              {t.name}
            </Link>
          ))}
        </div>
        <div className="chips" aria-label="Logo preview">
          {Object.entries(GIFT_DESIGNS).map(([k, d]) => (
            <Link key={k} href={qs(type, k)} className={`chip${k === design ? " on" : ""}`}>
              {d.label.replace(/ \(.*\)/, "")}
            </Link>
          ))}
        </div>
      </div>
      {problem ? (
        <p className="notice err">{problem}</p>
      ) : items.length === 0 ? (
        <p className="muted">No CJ listing in this style has a photo your logo can be previewed on right now. Try another style.</p>
      ) : (
        <>
          <p className="small muted">
            {items.length} products · live from CJ (refreshed every 30 minutes) · listings whose photos can’t show your logo on the bottle are left out · CJ confirms the exact print area when you order.
          </p>
          <div className="bf-grid">
            {items.map((b) => {
              const productId = imported.get(b.pid);
              return (
                <div key={b.pid} className="bf-card">
                  <div className="bf-photo">
                    <img src={`/admin/gifts/bottles/mock/${encodeURIComponent(b.pid)}?design=${design}`} alt={`${b.name} with your logo`} loading="lazy" />
                    {b.printable && <span className="bf-badge">Custom print listing</span>}
                  </div>
                  <div className="bf-name" title={b.name}>
                    {b.name}
                  </div>
                  <div className="bf-meta">
                    <b>{b.priceCents != null ? formatMoney(b.priceCents) : b.priceLabel ?? "?"}</b> CJ cost
                    {b.inventory != null ? ` · ${b.inventory.toLocaleString()} in stock` : ""}
                    {b.listedNum ? ` · ${b.listedNum} stores sell it` : ""}
                  </div>
                  {productId ? (
                    <Link href={`/admin/products/${productId}`} className="a-btn a-btn-ghost">
                      Imported · open
                    </Link>
                  ) : (
                    <form action={importProduct}>
                      <input type="hidden" name="pid" value={b.pid} />
                      {b.deliveryCycle && <input type="hidden" name="deliveryCycle" value={b.deliveryCycle} />}
                      <input type="hidden" name="back" value={back} />
                      <button className="a-btn a-btn-primary">Import</button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
