import Link from "next/link";
import { config } from "@/lib/config";
import { publishedProducts } from "@/lib/storefront";
import { LINK_LINE, DRAW_WATTS, PLATFORMS, runtimeHours } from "@/lib/lineup";
import ProductCard from "@/components/store/ProductCard";
import RuntimeCalculator from "@/components/store/RuntimeCalculator";

export const dynamic = "force-dynamic";
export const metadata = {
  title: `${config.storeName} — Off-grid power for portable Starlink`,
  description: "Run Starlink Mini on the DeWalt, Milwaukee, Makita, Ryobi or Bosch tool batteries you already own. Fused, field-tested power and off-grid gear.",
};

export default async function Home() {
  const gear = (await publishedProducts()).slice(0, 8);
  const hours5 = (n: number) => runtimeHours(5, n, DRAW_WATTS.typical).toFixed(1);

  return (
    <>
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Off-grid power for portable Starlink</p>
            <h1>Internet that runs on the batteries you already own.</h1>
            <p className="hero-lede">
              Clean, fused, field-tested power for Starlink Mini, built around the 18V and 20V tool batteries already in your truck.
              And the off-grid gear that goes with it.
            </p>
            <div className="hero-ctas">
              <Link href="/link" className="btn primary lg">
                Find your adapter
              </Link>
              <Link href="/shop" className="btn ghost lg">
                Shop off-grid gear
              </Link>
            </div>
          </div>
          <dl className="plate plate-hero" aria-label="Link Dual specifications">
            <div className="plate-head">
              <span>{config.storeName}</span>
              <span>Model · Link Dual</span>
            </div>
            <dt>Input</dt>
            <dd>2 × 18V / 20V MAX</dd>
            <dt>Output</dt>
            <dd>DC → Starlink Mini</dd>
            <dt>Runtime</dt>
            <dd>≈ {hours5(2)} h · 2 × 5Ah</dd>
            <dt>Protection</dt>
            <dd>Fuse · switch</dd>
            <dt>Status</dt>
            <dd className="plate-status">In testing</dd>
          </dl>
        </div>
        <div className="wrap spec-strip" aria-hidden>
          <span>12–48V DC in</span>
          <span>DeWalt · Milwaukee · Makita · Ryobi · Bosch</span>
          <span>≈ {hours5(1)} h per 5Ah</span>
          <span>Starlink Mini ready</span>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <p className="eyebrow">Step 1</p>
          <h2 className="section-title">Choose your battery.</h2>
          <div className="battery-row battery-row-5">
            {PLATFORMS.map((b) => (
              <Link key={b.id} href={`/link?battery=${b.id}#products`} className={`battery-tile ${b.status === "testing" ? "live" : ""}`}>
                <div className="battery-name">{b.brand}</div>
                <div className="battery-line">{b.line}</div>
                <div className="battery-status">
                  <span className="dot" aria-hidden /> {b.status === "testing" ? "In testing" : "Coming next"}
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section id="line" className="band">
        <div className="wrap">
          <p className="eyebrow">Step 2 · The Link line</p>
          <div className="section-head">
            <h2 className="section-title">Four kits. Five batteries. One standard.</h2>
            <p className="section-note">
              Launching once every sample passes our bench test: voltage under load, fuse, cutoff and a four-hour run.
            </p>
          </div>
          <div className="link-grid">
            {LINK_LINE.map((p) => (
              <article key={p.id} className="link-card">
                <div className="link-card-top">
                  <span className="badge-testing">In testing</span>
                  <span className="link-price">
                    <span className="muted-label">Planned</span> ${p.plannedPrice}
                  </span>
                </div>
                <h3>{p.name}</h3>
                <p>{p.summary}</p>
                <dl className="plate plate-card">
                  <div className="plate-row">
                    <dt>Fits</dt>
                    <dd>{p.fits.length === PLATFORMS.length ? "All 5 platforms" : PLATFORMS.filter((b) => p.fits.includes(b.id)).map((b) => b.brand).join(" · ")}</dd>
                  </div>
                  {p.specs.map(([label, value]) => (
                    <div key={label} className="plate-row">
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                  <div className="plate-row">
                    <dt>Runtime</dt>
                    <dd>
                      ≈ {hours5(p.batteries)} h · {p.batteries} × 5Ah
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
          <p className="line-cta">
            <Link href="/link" className="btn">
              Pick your battery and get notified
            </Link>
          </p>
        </div>
      </section>

      <section id="runtime" className="band band-dark">
        <div className="wrap">
          <p className="eyebrow">Runtime calculator</p>
          <h2 className="section-title">How long will you stay online?</h2>
          <RuntimeCalculator />
        </div>
      </section>

      {gear.length > 0 && (
        <section className="band">
          <div className="wrap">
            <p className="eyebrow">Around the core</p>
            <div className="section-head">
              <h2 className="section-title">The rest of the off-grid kit.</h2>
              <Link href="/shop" className="btn">
                Shop all gear
              </Link>
            </div>
            <div className="pgrid">
              {gear.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="band band-tight">
        <div className="wrap promise-row">
          <div>
            <h3>Sample-tested</h3>
            <p>Every product is bench-tested before it’s listed. If it fails, we don’t sell it.</p>
          </div>
          <div>
            <h3>Honest runtime</h3>
            <p>Hours per battery from real math, never “all-day power.”</p>
          </div>
          <div>
            <h3>Live stock</h3>
            <p>Availability is confirmed with our supplier again before you pay.</p>
          </div>
        </div>
      </section>
    </>
  );
}
