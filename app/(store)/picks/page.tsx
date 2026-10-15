import Link from "next/link";
import { picksFor, SECTORS, SPECIALTY, type Sector } from "@/lib/curated";

export const metadata = { title: "Vetted picks", description: `Hand-checked parts and tools for ${SPECIALTY}.` };

const ORDER: Sector[] = ["ev", "batteries", "robotics", "tools", "power"];
const usOnly = (why: string) => /US addresses only/i.test(why);

// The specialty catalogue: every product our buyer opened and passed, by sector, with the reason it passed.
// Prices are from the review; each card opens the product page with the live price, stock and shipping.
export default function PicksPage() {
  return (
    <div className="wrap page picks">
      <h1 className="page-title">Vetted picks</h1>
      <p className="picks-lede">
        Parts and tools for {SPECIALTY}. Each one was opened and checked by hand: specs that add up, named chips and models, a real description and stock that ships.
        Listings with impossible claims, like 9,900 mAh 18650 cells, never show up here.
      </p>
      <nav className="picks-nav" aria-label="Sectors">
        {ORDER.map((s) => (
          <a key={s} href={`#${s}`}>
            {SECTORS[s]}
          </a>
        ))}
      </nav>
      {ORDER.map((s) => {
        const picks = picksFor(s);
        return (
          <section key={s} id={s} className="picks-sector">
            <h2>
              {SECTORS[s]} <span className="muted small">{picks.length}</span>
            </h2>
            <div className="pgrid">
              {picks.map((p) => (
                <Link key={p.pid} href={`/search/item/${encodeURIComponent(p.pid)}`} className="pcard" prefetch={false}>
                  <div className="pcard-media">
                    <img src={`/media/p/${encodeURIComponent(p.pid)}`} alt={p.name} loading="lazy" />
                  </div>
                  <div className="pcard-body">
                    <div className="picks-tags">
                      <span className={`picks-tag ${p.verdict === "stock" ? "top" : ""}`}>{p.verdict === "stock" ? "Top pick" : "Good, read the note"}</span>
                      <span className="picks-tag">{p.category}</span>
                      {usOnly(p.why) && <span className="picks-tag warn">US only</span>}
                    </div>
                    <h3 className="pcard-title">{p.name}</h3>
                    <p className="picks-why">{p.why}</p>
                    <div className="pcard-foot">
                      <span className="pcard-price">
                        <span className="from">From </span>${p.fromUsd}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
      <p className="muted small">Prices are in USD and include everything but shipping. The product page shows the live price, stock and whether it ships to you.</p>
    </div>
  );
}
