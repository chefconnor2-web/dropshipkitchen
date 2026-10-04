import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Flash } from "@/components/admin";
import BoxBuilder from "@/components/admin-box-builder";

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
        <h2 className="a-h2">Design a new box</h2>
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
