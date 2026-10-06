import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { Flash, timeAgo } from "@/components/admin";
import { saveSeaRatesAction, setFreightStatusAction } from "@/app/admin/actions";
import type { FreightLine } from "@/lib/freight";
import { getSeaRates, seaPriceCents } from "@/lib/sea";
import { supplierMode } from "@/lib/fulfillment";

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
  const sea = await getSeaRates();
  const dollars = (c: number) => (c ? (c / 100).toFixed(2) : "");

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
      <section className="a-card" id="sea">
        <div className="a-card-head">
          <h2 className="a-h2">Sea shipping to Canada · automatic</h2>
          <span className={`chip-status ${sea.enabled ? "tone-good" : "tone-muted"}`}>{sea.enabled ? "On" : "Off"}</span>
        </div>
        <p className="small muted">
          For items CJ can’t fly (big lithium and EV batteries). Ask your CJ agent once for their China → Canada sea rate for dangerous goods,
          enter it here, and Canadian shoppers get a sea price right in the cart and check out like any other order. When they pay, the
          booking is emailed to your agent{supplierMode() === "live" ? "" : " (in test mode it comes to your store inbox instead)"}. When the agent
          replies, paste CJ’s order id or tracking number on the order and tracking runs on its own.
        </p>
        <form action={saveSeaRatesAction} className="sea-rates">
          <label>
            Freight per kg (USD)
            <input name="perKg" inputMode="decimal" defaultValue={dollars(sea.perKgCents)} placeholder="e.g. 4.50" />
          </label>
          <label>
            Minimum freight (USD)
            <input name="min" inputMode="decimal" defaultValue={dollars(sea.minCents)} placeholder="e.g. 150" />
          </label>
          <label>
            Per order: customs, port, delivery (USD)
            <input name="perOrder" inputMode="decimal" defaultValue={dollars(sea.perOrderCents)} placeholder="e.g. 120" />
          </label>
          <label>
            Safety buffer (%)
            <input name="bufferPct" inputMode="decimal" defaultValue={String(sea.bufferPct)} />
          </label>
          <label className="wide">
            CJ agent email (bookings go here)
            <input name="agentEmail" type="email" defaultValue={sea.agentEmail} placeholder="agent@cjdropshipping.com" />
          </label>
          <label className="check">
            <input type="checkbox" name="autoBook" defaultChecked={sea.autoBook} /> Email the booking automatically when the customer pays
          </label>
          <label className="check">
            <input type="checkbox" name="enabled" defaultChecked={sea.enabled} /> Sell sea shipping to Canada at checkout
          </label>
          <button className="a-btn a-btn-primary">Save</button>
        </form>
        {sea.perKgCents > 0 && (
          <p className="small">
            Customer pays for sea shipping:{" "}
            {[10, 30, 60, 120].map((kg) => `${kg} kg ${formatMoney(seaPriceCents(kg * 1000, sea))}`).join(" · ")}
          </p>
        )}
      </section>
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
