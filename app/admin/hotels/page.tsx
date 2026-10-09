import { prisma } from "@/lib/db";
import { timeAgo } from "@/components/admin";
import { stayLabel, stayUrl } from "@/lib/hotel-booking";
import { liteapiTestMode } from "@/lib/liteapi";
import { stayPrice, type HotelCard } from "@/lib/flights-shared";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: string }> = {
  PENDING_PAYMENT: { label: "Not paid", tone: "tone-muted" },
  BOOKING: { label: "Booking…", tone: "tone-busy" },
  BOOKED: { label: "Booked", tone: "tone-good" },
  FAILED_REFUNDED: { label: "Refunded", tone: "tone-bad" },
  NEEDS_REVIEW: { label: "Needs review", tone: "tone-warn" },
};

export default async function HotelsAdminPage() {
  const rows = await prisma.hotelBooking.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  const booked = rows.filter((r) => r.status === "BOOKED").length;
  const review = rows.filter((r) => r.status === "NEEDS_REVIEW").length;
  const links = new Map(await Promise.all(rows.map(async (r) => [r.id, await stayUrl(r)] as const)));
  return (
    <>
      <div className="a-head">
        <div>
          <h1>Hotels</h1>
          <div className="a-sub">
            {booked} booked · {review ? `${review} need review · ` : ""}
            {liteapiTestMode() ? "LiteAPI sandbox: no real rooms" : "LiteAPI live"}
          </div>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="a-empty">
          <p className="a-empty-title">No hotel bookings yet.</p>
          <p className="muted small">They appear when a shopper taps Book on a hotel in the chat.</p>
        </div>
      ) : (
        rows.map((r) => {
          const card = JSON.parse(r.cardJson) as HotelCard;
          const st = STATUS[r.status] ?? STATUS.PENDING_PAYMENT;
          // Our fee, before card processing (LiteAPI's commission comes on top, paid by LiteAPI).
          const fee = r.priceCents - Math.round(Number(r.liteAmount) * 100);
          return (
            <section key={r.id} className="a-card">
              <div className="a-card-head">
                <h2 className="a-h2">
                  {stayLabel(card)} · {stayPrice({ priceCents: r.priceCents, currency: r.currency })}
                </h2>
                <span className={`chip-status ${st.tone}`}>{st.label}</span>
              </div>
              <p className="small">
                <code>{r.number}</code> · {r.email} · {r.firstName} {r.lastName} · {timeAgo(r.createdAt)}
              </p>
              <p className="small muted">
                LiteAPI {r.currency} {r.liteAmount} · our fee {stayPrice({ priceCents: fee, currency: r.currency })}
                {r.confirmationCode ? ` · confirmation ${r.confirmationCode}` : ""}
                {r.liteBookingId ? ` · LiteAPI ${r.liteBookingId}` : ""}
                {r.stripeRefundId ? ` · refund ${r.stripeRefundId}` : ""}
              </p>
              {r.error && <p className="notice err small">{r.error}</p>}
              <p className="small">
                <a href={links.get(r.id)} target="_blank" rel="noreferrer">
                  Customer&apos;s stay page ↗
                </a>
              </p>
            </section>
          );
        })
      )}
    </>
  );
}
