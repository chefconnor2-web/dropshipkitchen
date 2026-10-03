import Link from "next/link";
import { config } from "@/lib/config";
import {
  DRAW_WATTS,
  LINK_LINE,
  PLATFORMS,
  UNSUPPORTED,
  platformById,
  platformName,
  runtimeHours,
} from "@/lib/lineup";
import WaitlistForm from "@/components/store/WaitlistForm";

export const metadata = {
  title: `The Link line: Starlink Mini battery adapters — ${config.storeName}`,
  description:
    "Run Starlink Mini on DeWalt 20V MAX, Milwaukee M18, Makita 18V LXT, Ryobi 18V ONE+ or Bosch 18V tool batteries. Fused, switched, bench-tested.",
};

const FAQ: Array<[q: string, a: string]> = [
  [
    "Will it hurt my battery?",
    "No. Starlink Mini draws 17–40W, far less than a drill or saw. Link Dock and Link Dual add a low-voltage cutoff so a pack is never run flat; on Link Cable your pack’s own protection does that job.",
  ],
  [
    "Which Starlink does it power?",
    "Starlink Mini, which runs on 12–48V DC. Standard and Gen 3 dishes need far more power and aren’t supported.",
  ],
  [
    "Can I charge my battery through it?",
    "No. Link products only take power out of the battery. Charge packs on your normal charger.",
  ],
  [
    "When can I buy one?",
    "When the samples for your battery pass our bench test: voltage under load, fuse, cutoff and a four-hour run. Join the list on the product you want and we’ll email you once it does.",
  ],
];

export default async function LinkLinePage({ searchParams }: { searchParams: Promise<{ battery?: string }> }) {
  const { battery } = await searchParams;
  const platform = platformById(battery);
  const name = platformName(platform);
  const hrs = (ah: number, n: number) => runtimeHours(ah, n, DRAW_WATTS.typical).toFixed(1);

  return (
    <>
      <section className="band band-dark link-hero">
        <div className="wrap">
          <p className="eyebrow">Featured · The Link line</p>
          <h1 className="link-title">Starlink Mini, powered by the battery you already own.</h1>
          <p className="section-lede">
            One adapter standard across five tool-battery platforms. Pick yours and see what fits, how long it runs, and
            when it ships.
          </p>

          <nav className="platform-picker" aria-label="Choose your battery platform">
            {PLATFORMS.map((p) => (
              <Link
                key={p.id}
                href={`/link?battery=${p.id}#products`}
                scroll={false}
                aria-current={p.id === platform.id ? "true" : undefined}
                className={`platform-tile ${p.id === platform.id ? "on" : ""}`}
              >
                <span className="platform-brand">{p.brand}</span>
                <span className="platform-line">{p.line}</span>
                <span className={`platform-status ${p.status}`}>
                  <span className="dot" aria-hidden /> {p.status === "testing" ? "In testing" : "Coming next"}
                </span>
              </Link>
            ))}
          </nav>
        </div>
      </section>

      <section id="products" className="band">
        <div className="wrap">
          <div className="platform-summary">
            <div>
              <p className="eyebrow">Your battery</p>
              <h2 className="section-title">{name}</h2>
              <p className="platform-packs">
                <span className="muted-label">Fits packs like</span>
                {platform.packs.map((k) => (
                  <span key={k} className="pack-chip">
                    {k}
                  </span>
                ))}
              </p>
            </div>
            <dl className="plate plate-runtime" aria-label={`Runtime on ${name} batteries`}>
              <div className="plate-row">
                <dt>1 × 5Ah</dt>
                <dd>≈ {hrs(5, 1)} h</dd>
              </div>
              <div className="plate-row">
                <dt>1 × 8Ah</dt>
                <dd>≈ {hrs(8, 1)} h</dd>
              </div>
              <div className="plate-row">
                <dt>2 × 5Ah</dt>
                <dd>≈ {hrs(5, 2)} h</dd>
              </div>
              <div className="plate-row">
                <dt>2 × 12Ah</dt>
                <dd>≈ {hrs(12, 2)} h</dd>
              </div>
              <p className="plate-foot">
                At a typical {DRAW_WATTS.typical}W. <Link href="/runtime">Work out your own</Link>
              </p>
            </dl>
          </div>

          {platform.status === "next" && (
            <p className="notice platform-note">
              {name} is next on our list. We haven’t ordered samples yet, so join the list on the product you want. Demand
              decides what we build first.
            </p>
          )}

          <div className="link-grid">
            {LINK_LINE.map((p) => {
              const fits = p.fits.includes(platform.id);
              const building = fits && platform.status === "testing";
              return (
                <article key={p.id} className={`link-card ${fits ? "" : "link-card-off"}`}>
                  <div className="link-card-top">
                    <span className={building ? "badge-testing" : "badge-planned"}>
                      {building ? "In testing" : fits ? "Coming next" : `Not yet for ${platform.brand}`}
                    </span>
                    <span className="link-price">
                      <span className="muted-label">Planned</span> ${p.plannedPrice}
                    </span>
                  </div>
                  <h3>{p.name}</h3>
                  <p>{p.summary}</p>
                  <dl className="plate plate-card">
                    <div className="plate-row">
                      <dt>Input</dt>
                      <dd>
                        {p.batteries} × {platform.line}
                      </dd>
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
                        ≈ {hrs(5, p.batteries)} h · {p.batteries} × 5Ah
                      </dd>
                    </div>
                  </dl>
                  <WaitlistForm
                    key={`${platform.id}-${p.id}`}
                    platform={platform.id}
                    productId={p.id}
                    cta={fits ? "Notify me" : `Ask for ${platform.brand}`}
                  />
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="band band-tight">
        <div className="wrap faq-grid">
          <div>
            <p className="eyebrow">Questions</p>
            <h2 className="section-title">Before you plug in.</h2>
            <div className="unsupported">
              <h3>Not supported, on purpose</h3>
              <ul>
                {UNSUPPORTED.map((u) => (
                  <li key={u.name}>
                    <strong>{u.name}.</strong> {u.why}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
