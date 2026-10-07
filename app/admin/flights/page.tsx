import { prisma } from "@/lib/db";
import { timeAgo } from "@/components/admin";
import { confirmationEmailStatus, routeLabel, tripUrl, type PassengerInput } from "@/lib/flight-booking";
import { duffelTestMode } from "@/lib/duffel";
import { flightPrice, type FlightCard } from "@/lib/flights-shared";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: string }> = {
  PENDING_PAYMENT: { label: "Not paid", tone: "tone-muted" },
  BOOKING: { label: "Booking…", tone: "tone-busy" },
  BOOKED: { label: "Booked", tone: "tone-good" },
  FAILED_REFUNDED: { label: "Refunded", tone: "tone-bad" },
  NEEDS_REVIEW: { label: "Needs review", tone: "tone-warn" },
};

export default async function FlightsAdminPage() {
  const rows = await prisma.flightBooking.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  const booked = rows.filter((r) => r.status === "BOOKED");
  // Our fee, before card processing and Duffel's per-booking fee (both come out of it).
  const fee = (r: (typeof rows)[number]) => r.priceCents - Math.round(Number(r.duffelAmount) * 100);
  const review = rows.filter((r) => r.status === "NEEDS_REVIEW").length;
  const links = new Map(await Promise.all(rows.map(async (r) => [r.id, await tripUrl(r)] as const)));
  const emails = new Map(await Promise.all(rows.map(async (r) => [r.id, await confirmationEmailStatus(r)] as const)));
  return (
    <>
      <div className="a-head">
        <div>
          <h1>Flights</h1>
          <div className="a-sub">
            {booked.length} booked · {review ? `${review} need review · ` : ""}
            {duffelTestMode() ? "Duffel test mode: no real tickets" : "Duffel live"}
          </div>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="a-empty">
          <p className="a-empty-title">No flight bookings yet.</p>
          <p className="muted small">They appear when a shopper taps Book on a flight in the chat.</p>
        </div>
      ) : (
        rows.map((r) => {
          const card = JSON.parse(r.cardJson) as FlightCard;
          const st = STATUS[r.status] ?? STATUS.PENDING_PAYMENT;
          const names = (JSON.parse(r.passengersJson) as PassengerInput[]).map((p) => `${p.given_name} ${p.family_name}`).join(", ");
          return (
            <section key={r.id} className="a-card">
              <div className="a-card-head">
                <h2 className="a-h2">
                  {routeLabel(card)} · {flightPrice({ priceCents: r.priceCents, currency: r.currency })}
                </h2>
                <span className={`chip-status ${st.tone}`}>{st.label}</span>
              </div>
              <p className="small">
                <code>{r.number}</code> · {r.email} · {names} · {timeAgo(r.createdAt)}
              </p>
              <p className="small muted">
                {card.airline} · airline {r.currency} {r.duffelAmount} · our fee {flightPrice({ priceCents: fee(r), currency: r.currency })}
                {r.bookingReference ? ` · PNR ${r.bookingReference}` : ""}
                {r.duffelOrderId ? ` · Duffel ${r.duffelOrderId}` : ""}
                {r.stripeRefundId ? ` · refund ${r.stripeRefundId}` : ""}
                {r.status === "BOOKED" ? ` · confirmation email ${emails.get(r.id) ?? "pending"}` : ""}
              </p>
              {r.error && <p className="notice err small">{r.error}</p>}
              <p className="small">
                <a href={links.get(r.id)} target="_blank" rel="noreferrer">
                  Customer&apos;s trip page ↗
                </a>
              </p>
            </section>
          );
        })
      )}
    </>
  );
}
