import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { loadPool, simulate } from "@/lib/mystery";
import { subscribeToBox } from "../../actions";
import { getShipTo } from "@/lib/cart";
import { countryLabel } from "@/lib/shipping";
import { getPlan, planRules } from "@/lib/plan";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const box = await prisma.mysteryBox.findFirst({ where: { slug: (await params).slug, status: "PUBLISHED" } });
  return box ? { title: `${box.name} — ${config.storeName}`, description: box.tagline } : {};
}

export default async function BoxPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string }> }) {
  const { slug } = await params;
  const { error } = await searchParams;
  const box = await prisma.mysteryBox.findFirst({
    where: { slug, status: "PUBLISHED" },
    include: { pool: { take: 8, include: { variant: { include: { product: { include: { images: { take: 1, orderBy: { position: "asc" } } } } } } } } },
  });
  if (!box) notFound();
  // Sold only as Full's monthly surplus box: priced and drawn under the plan (price and margin).
  const plan = await getPlan();
  const available = simulate(await loadPool(box.id), planRules(box, plan), 40).successRate > 0;
  const shipTo = await getShipTo();
  const teasers = [...new Map(box.pool.map((p) => [p.variant.productId, p.variant.product.images[0]?.id])).values()].filter(Boolean).slice(0, 6);

  return (
    <div className="wrap page">
      <nav className="crumbs small" aria-label="Breadcrumb">
        <Link href="/boxes">Mystery boxes</Link> / <span>{box.name}</span>
      </nav>
      <div className="box-pdp">
        <div className="box-pdp-art">
          <div className="box-art box-art-lg" aria-hidden>
            <span>?</span>
          </div>
          {teasers.length > 0 && (
            <div className="box-teasers" aria-label="A peek at the kind of items inside">
              {teasers.map((id) => (
                <img key={id} src={`/media/${id}`} alt="" loading="lazy" />
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="eyebrow">Surplus mystery box · every month with Full</p>
          <h1 className="page-title">{box.name}</h1>
          <p className="box-tagline">{box.tagline}</p>
          <div className="price">
            {formatMoney(plan.priceCents)}/month
            <span className="box-value">plus shipping · includes Full: 2× the assistant usage of Lite</span>
          </div>
          <ul className="box-promises">
            <li>
              <strong>{box.itemCount} different items</strong>, worth at least {formatMoney(plan.priceCents)} at our regular prices
            </li>
            <li>
              <strong>A new box every month</strong>, with shipping to {countryLabel(shipTo.country)} added to your monthly bill (shown before you pay)
            </li>
            <li>
              <strong>The shopping assistant</strong> with 2× the usage of Lite
            </li>
            <li>Cancel any time from your account</li>
          </ul>
          {error && <p className="notice err">{error}</p>}
          {available ? (
            <form action={subscribeToBox}>
              <input type="hidden" name="boxId" value={box.id} />
              <button className="btn primary lg">Subscribe to Full · {formatMoney(plan.priceCents)}/month + shipping</button>
            </form>
          ) : (
            <p className="notice">Sold out right now. Check back soon.</p>
          )}
          {box.description && <p className="box-desc">{box.description}</p>}
          <p className="muted small">
            Items are picked at random from a pool of similar products and shipped straight from our suppliers, so they may arrive in more than one
            package. Boxes can’t be swapped for specific items; anything faulty is replaced or refunded.
          </p>
        </div>
      </div>
    </div>
  );
}
