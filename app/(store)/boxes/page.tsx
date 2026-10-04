import Link from "next/link";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: `Mystery boxes — ${config.storeName}` };

export default async function BoxesPage() {
  const boxes = await prisma.mysteryBox.findMany({ where: { status: "PUBLISHED" }, orderBy: { priceCents: "asc" } });
  return (
    <>
      <section className="band band-dark search-hero">
        <div className="wrap">
          <p className="eyebrow">Mystery boxes</p>
          <h1 className="section-title">Surprise picks from Chinese factories. Always worth more than you pay.</h1>
          <p className="section-lede">Subscribe and get a box every month: a set number of different items, always worth more than you pay. Every subscription includes our AI sourcing assistant.</p>
        </div>
      </section>
      <section className="band">
        <div className="wrap">
          {boxes.length === 0 ? (
            <p className="muted">New boxes are on the way. Check back soon.</p>
          ) : (
            <div className="box-grid">
              {boxes.map((b) => (
                <Link key={b.id} href={`/boxes/${b.slug}`} className="box-card">
                  <div className="box-art" aria-hidden>
                    <span>?</span>
                    <em className="box-badge">Worth {formatMoney(b.guaranteedValueCents)}+</em>
                  </div>
                  <div className="box-card-body">
                    <h2>{b.name}</h2>
                    <p>{b.tagline}</p>
                    <div className="box-card-foot">
                      <strong>{formatMoney(b.priceCents)}/mo</strong>
                      <span>
                        {b.itemCount} items · worth {formatMoney(b.guaranteedValueCents)}+
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
