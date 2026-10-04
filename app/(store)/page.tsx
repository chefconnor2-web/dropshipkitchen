import Link from "next/link";
import { config } from "@/lib/config";
import { publishedProducts } from "@/lib/storefront";
import ProductCard from "@/components/store/ProductCard";

export const dynamic = "force-dynamic";
export const metadata = {
  title: `${config.storeName} — Chinese tools & gadgets, shipped to Canada`,
  description: "Canada’s trusted source for Chinese tools and gadgets. Factory-direct prices, with your price and shipping shown before you pay.",
};

// Each tile searches the whole catalog, so it never runs dry.
const AISLES = [
  { name: "Cordless drills", q: "cordless drill", note: "Drills, drivers, kits" },
  { name: "Impact & grinders", q: "angle grinder", note: "Grinders, impact wrenches" },
  { name: "Hand tools", q: "tool set", note: "Sets, wrenches, sockets" },
  { name: "Measuring", q: "laser level", note: "Levels, calipers, testers" },
  { name: "Work lights", q: "led work light", note: "Rechargeable, magnetic" },
  { name: "Gadgets", q: "gadget", note: "Clever stuff for the bench" },
];

const PROMISES = [
  { h: "Factory-direct prices", p: "Straight from the makers in China, without the big-box markup." },
  { h: "Shipping shown upfront", p: "Enter your postal code on any product and see the real shipping cost before you buy." },
  { h: "Stock checked live", p: "Availability is re-confirmed with our supplier before you pay." },
];

export default async function Home() {
  const gear = (await publishedProducts()).slice(0, 8);

  return (
    <>
      <section className="hero cn-hero">
        <div className="wrap cn-hero-inner">
          <p className="eyebrow">Shipping across Canada 🍁</p>
          <h1>{config.storeName}</h1>
          <p className="hero-lede">Canada’s trusted source for Chinese tools &amp; gadgets.</p>
          <form className="search-big" role="search" action="/search">
            <label className="sr-only" htmlFor="home-q">
              Search tools and gadgets
            </label>
            <input id="home-q" name="q" type="search" placeholder="Search drills, wrenches, gadgets…" />
            <button className="btn primary lg">Search</button>
          </form>
          <div className="spec-strip cn-strip" aria-hidden>
            <span>Thousands of tools</span>
            <span>Price + shipping before you pay</span>
            <span>Secure checkout</span>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <p className="eyebrow">Shop the aisles</p>
          <h2 className="section-title">What are you fixing today?</h2>
          <div className="aisle-grid">
            {AISLES.map((a) => (
              <Link key={a.name} href={`/search?q=${encodeURIComponent(a.q)}`} className="aisle">
                <span className="aisle-name">{a.name}</span>
                <span className="aisle-note">{a.note}</span>
                <span className="aisle-go" aria-hidden>
                  →
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {gear.length > 0 && (
        <section className="band">
          <div className="wrap">
            <p className="eyebrow">Picked for you</p>
            <div className="section-head">
              <h2 className="section-title">Bestsellers on the bench.</h2>
              <Link href="/shop" className="btn">
                Shop all
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

      <section className="band band-dark">
        <div className="wrap feature-row">
          <div>
            <p className="eyebrow">Featured</p>
            <h2 className="section-title">Battery adapters for every tool brand.</h2>
            <p className="section-lede">
              DeWalt, Milwaukee, Makita, Ryobi and Bosch packs, powering Starlink Mini and more. Pick your battery and get
              notified at launch.
            </p>
            <Link href="/link" className="btn primary lg">
              Find your adapter
            </Link>
          </div>
        </div>
      </section>

      <section className="band band-tight">
        <div className="wrap promise-row">
          {PROMISES.map((x) => (
            <div key={x.h}>
              <h3>{x.h}</h3>
              <p>{x.p}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
