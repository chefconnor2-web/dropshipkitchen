import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Flash } from "@/components/admin";
import BoxBuilder from "@/components/admin-box-builder";
import { BOX_PRESETS, presetJob } from "@/lib/box-presets";
import { buildPresetBoxesAction } from "@/app/admin/actions";

export const dynamic = "force-dynamic";

export default async function BoxesPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  const boxes = await prisma.mysteryBox.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { pool: true } } } });
  return (
    <>
      <div className="a-head">
        <div>
          <h1>Mystery boxes</h1>
          <div className="a-sub">Describe a box; the AI finds the products, names it and checks the numbers.</div>
        </div>
      </div>
      <Flash notice={notice} error={error} />
      <section className="a-card">
        <h2 className="a-h2">Preset high-value boxes</h2>
        <p className="small muted">
          {BOX_PRESETS.length} ready-made boxes, each guaranteed to be worth about 1.5× its price. The AI builds them one by one and publishes the healthy
          ones.
        </p>
        <ul className="small preset-list">
          {BOX_PRESETS.map((p) => {
            const built = boxes.some((b) => b.brief === p.brief);
            return (
              <li key={p.key}>
                {built ? "✓" : presetJob.current === p.key ? "…" : "○"} {p.brief.split(":")[0]} · ${p.priceCents / 100} · {p.itemCount} items · worth ${(p.guaranteedValueCents ?? 0) / 100}+
              </li>
            );
          })}
        </ul>
        {presetJob.running ? (
          <ul className="box-log">
            {presetJob.log.slice(-8).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : (
          <form action={buildPresetBoxesAction}>
            <button className="a-btn a-btn-primary" disabled={BOX_PRESETS.every((p) => boxes.some((b) => b.brief === p.brief))}>
              Build the preset boxes
            </button>
          </form>
        )}
      </section>

      <section className="a-card">
        <h2 className="a-h2">Design your own box</h2>
        <BoxBuilder />
      </section>
      <section className="a-card">
        <h2 className="a-h2">Your boxes</h2>
        {boxes.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <ul className="mini-list">
            {boxes.map((b) => (
              <li key={b.id}>
                <Link href={`/admin/boxes/${b.id}`}>
                  <span className="strong">{b.name}</span>
                  <span className="muted small">
                    {formatMoney(b.priceCents)} · {b.itemCount} items · worth {formatMoney(b.guaranteedValueCents)}+ · {b._count.pool} options in pool
                  </span>
                  <span className="mini-right">
                    <span className={`chip-status ${b.status === "PUBLISHED" ? "tone-good" : "tone-muted"}`}>{b.status === "PUBLISHED" ? "Live" : "Draft"}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
