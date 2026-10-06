import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Flash, timeAgo } from "@/components/admin";
import { setFreightStatusAction } from "@/app/admin/actions";
import type { FreightLine } from "@/lib/freight";

const STATUSES = [
  { key: "new", label: "New", tone: "tone-warn" },
  { key: "quoted", label: "Quoted", tone: "tone-muted" },
  { key: "won", label: "Won", tone: "tone-good" },
  { key: "lost", label: "Lost", tone: "tone-bad" },
] as const;

export default async function FreightPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  const requests = await prisma.freightRequest.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  const open = requests.filter((r) => r.status === "new").length;

  return (
    <>
      <div className="a-head">
        <div>
          <h1>Freight requests</h1>
          <div className="a-sub">
            {open} new · large orders asking for a freight quote, and items that can’t fly (big lithium batteries) going to Canada by sea
          </div>
        </div>
      </div>
      <Flash notice={notice} error={error} />
      <section className="a-card">
        <p className="small muted">
          Arrange these with CJ’s team (CJ dashboard → Wholesale / bulk shipping, or your CJ agent), then reply to the customer by email
          with the price and a payment link. Mark each one as you go.
        </p>
      </section>
      {requests.length === 0 ? (
        <div className="a-empty">
          <p className="a-empty-title">No freight requests yet.</p>
          <p className="muted small">They appear when a large cart asks for a freight quote.</p>
        </div>
      ) : (
        requests.map((r) => {
          const items = JSON.parse(r.itemsJson) as FreightLine[];
          const st = STATUSES.find((s) => s.key === r.status) ?? STATUSES[0];
          return (
            <section key={r.id} className="a-card">
              <div className="a-card-head">
                <h2 className="a-h2">
                  {formatMoney(r.subtotalCents)} to {r.country} {r.postalCode}
                </h2>
                {r.mode === "sea" && <span className="chip-status tone-busy">Sea · can’t fly</span>}
                <span className={`chip-status ${st.tone}`}>{st.label}</span>
              </div>
              <p className="small">
                <a href={`mailto:${r.email}?subject=${encodeURIComponent("Your freight quote")}`}>{r.email}</a>
                {r.company ? ` · ${r.company}` : ""} · {timeAgo(r.createdAt)}
              </p>
              <ul className="mini-list">
                {items.map((i, n) => (
                  <li key={n}>
                    <div className="mini-row">
                      <span className="strong">
                        {i.quantity} × {i.title}
                      </span>
                      <span className="muted small">
                        {i.option && !/^default$/i.test(i.option) ? `${i.option} · ` : ""}
                        {formatMoney(i.unitCents)} each{i.pid ? ` · CJ ${i.pid}` : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="small muted">
                Parcel shipping would be {r.parcelQuoteCents != null ? formatMoney(r.parcelQuoteCents) : "not available"}.
                {r.notes ? ` Notes: ${r.notes}` : ""}
              </p>
              <form action={setFreightStatusAction} className="email-list-actions">
                <input type="hidden" name="id" value={r.id} />
                {STATUSES.filter((s) => s.key !== r.status).map((s) => (
                  <button key={s.key} className="a-btn a-btn-sm" name="status" value={s.key}>
                    Mark {s.label.toLowerCase()}
                  </button>
                ))}
              </form>
            </section>
          );
        })
      )}
    </>
  );
}
