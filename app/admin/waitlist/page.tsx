import Link from "next/link";
import { prisma } from "@/lib/db";
import { LINK_LINE, PLATFORMS, platformById, platformName, linkProductById } from "@/lib/lineup";
import { timeAgo } from "@/components/admin";

export default async function WaitlistPage() {
  const [groups, recent, people] = await Promise.all([
    prisma.waitlistEntry.groupBy({ by: ["platform", "productId"], _count: { _all: true } }),
    prisma.waitlistEntry.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.waitlistEntry.findMany({ distinct: ["email"], select: { email: true } }),
  ]);
  const count = (platform: string, productId: string) =>
    groups.find((g) => g.platform === platform && g.productId === productId)?._count._all ?? 0;
  const byPlatform = PLATFORMS.map((p) => ({ p, n: LINK_LINE.reduce((s, l) => s + count(p.id, l.id), 0) })).sort((a, b) => b.n - a.n);
  const total = groups.reduce((s, g) => s + g._count._all, 0);
  const max = Math.max(1, ...byPlatform.map((x) => x.n));

  return (
    <>
      <div className="a-head">
        <div>
          <h1>Waitlist</h1>
          <div className="a-sub">
            {people.length} {people.length === 1 ? "person" : "people"} · {total} sign-up{total === 1 ? "" : "s"} for the Link line
          </div>
        </div>
        <a href="/admin/waitlist/export" className="a-btn a-btn-sm">
          Export CSV
        </a>
      </div>

      <section className="a-card">
        <h2 className="a-h2">Demand by battery</h2>
        <ul className="demand-list">
          {byPlatform.map(({ p, n }) => (
            <li key={p.id}>
              <div className="demand-label">
                <span className="strong">{platformName(p)}</span>
                <span className="muted small">{p.status === "testing" ? "Samples requested" : "Not requested yet"}</span>
              </div>
              <div className="demand-bar" aria-hidden>
                {n > 0 && <span style={{ width: `${(n / max) * 100}%` }} />}
              </div>
              <span className="demand-n">{n}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="a-card">
        <h2 className="a-h2">By product</h2>
        <div className="demand-table-wrap">
          <table className="demand-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                {PLATFORMS.map((p) => (
                  <th key={p.id} scope="col">
                    {p.brand}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {LINK_LINE.map((l) => (
                <tr key={l.id}>
                  <th scope="row">{l.name}</th>
                  {PLATFORMS.map((p) => (
                    <td key={p.id} className={l.fits.includes(p.id) ? "" : "demand-ask"} title={l.fits.includes(p.id) ? undefined : "Not planned for this battery yet"}>
                      {count(p.id, l.id) || "·"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Grey cells are asks for a battery that product isn’t planned for yet.</p>
      </section>

      <section className="a-card">
        <h2 className="a-h2">Latest sign-ups</h2>
        {recent.length === 0 ? (
          <p className="muted small">
            No sign-ups yet. They come from the <Link href="/link">Link line page</Link>.
          </p>
        ) : (
          <ul className="mini-list">
            {recent.map((e) => (
              <li key={e.id}>
                <div className="mini-row">
                  <span className="strong">{e.email}</span>
                  <span className="muted small">
                    {platformName(platformById(e.platform))} · {linkProductById(e.productId)?.name ?? e.productId} · {timeAgo(e.createdAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
