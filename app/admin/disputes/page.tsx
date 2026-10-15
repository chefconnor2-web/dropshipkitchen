import { prisma } from "@/lib/db";
import { timeAgo } from "@/components/admin";
import { disputeAction } from "../money-actions";

export const dynamic = "force-dynamic";

const OPEN = new Set(["warning_needs_response", "needs_response"]);
const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");

/** Card disputes: what happened, what Chit did, and the one tap left to the owner. */
export default async function DisputesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const rows = await prisma.dispute.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  const open = rows.filter((r) => OPEN.has(r.status)).length;
  return (
    <>
      <div className="a-head">
        <div>
          <h1>Disputes</h1>
          <div className="a-sub">
            {open} open · Chit sends the evidence by itself; cancel within 24 hours instead if the trip hasn&apos;t happened.
          </div>
        </div>
      </div>
      {error && <p className="notice err">{error}</p>}
      {rows.length === 0 ? (
        <div className="a-empty">
          <p className="a-empty-title">No disputes.</p>
          <p className="muted small">If a customer disputes a payment with their bank, it shows here and you get an email.</p>
        </div>
      ) : (
        rows.map((r) => {
          const isOpen = OPEN.has(r.status);
          const handled = r.evidenceSubmitted ? `Evidence sent ${fmt(r.evidenceSubmitted)}` : r.cancelledAt ? `Booking cancelled and dispute accepted ${fmt(r.cancelledAt)}` : isOpen ? "Evidence goes out automatically" : "";
          return (
            <section key={r.id} className="a-card">
              <div className="a-card-head">
                <h2 className="a-h2">
                  {r.bookingNumber ?? r.chargeId} · {(r.amountCents / 100).toFixed(2)} {r.currency.toUpperCase()}
                </h2>
                <span className={`chip-status ${r.status === "won" ? "tone-good" : r.status === "lost" ? "tone-bad" : isOpen ? "tone-warn" : "tone-busy"}`}>{r.status.replace(/_/g, " ")}</span>
              </div>
              <p className="small">
                {r.kind} · {r.reason.replace(/_/g, " ")} · {r.email ?? "unknown customer"} · {timeAgo(r.createdAt)} · 3-D Secure: {r.threeDs ? "yes" : "no"}
              </p>
              <p className="small muted">
                Respond by {fmt(r.dueBy)}
                {handled ? ` · ${handled}` : ""} · <code>{r.id}</code>
              </p>
              {isOpen && !r.evidenceSubmitted && !r.cancelledAt && (r.kind === "flight" || r.kind === "hotel") && (
                <div className="a-actions">
                  <form action={disputeAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="do" value="cancel" />
                    <button className="btn">Cancel booking and accept</button>
                  </form>
                  <form action={disputeAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="do" value="evidence" />
                    <button className="btn primary">Send evidence now</button>
                  </form>
                </div>
              )}
              {isOpen && r.kind !== "flight" && r.kind !== "hotel" && <p className="small">Respond in Stripe (Payments → Disputes).</p>}
            </section>
          );
        })
      )}
    </>
  );
}
