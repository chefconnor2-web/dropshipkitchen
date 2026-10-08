import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { timeAgo } from "@/components/admin";
import { supplierMode } from "@/lib/fulfillment";
import { GIFT_DESIGNS, giftableVariants, giftEstimate, giftUrl } from "@/lib/gifts";
import { cancelGiftAction, sendGiftsAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: string }> = {
  SENT: { label: "Waiting for address", tone: "tone-warn" },
  CLAIMED: { label: "Claimed", tone: "tone-good" },
  CANCELLED: { label: "Cancelled", tone: "tone-muted" },
};

export default async function GiftsPage({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string; skipped?: string }> }) {
  const sp = await searchParams;
  const variants = await giftableVariants();
  const estimates = await Promise.all(variants.map((v) => giftEstimate(v)));
  const customers = await prisma.customer.findMany({ orderBy: { createdAt: "asc" }, take: 300, select: { id: true, email: true, name: true, createdAt: true } });
  const gifts = await prisma.gift.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  const orders = new Map((await prisma.order.findMany({ where: { id: { in: gifts.map((g) => g.orderId).filter((x): x is string => !!x) } }, select: { id: true, number: true, status: true } })).map((o) => [o.id, o]));
  const variantLabel = new Map(variants.map((v) => [v.variantId, v.label]));
  const already = new Set(gifts.filter((g) => g.status !== "CANCELLED").map((g) => g.email));
  const mode = supplierMode();

  return (
    <>
      <div className="a-head">
        <div>
          <h1>Gifts</h1>
          <div className="a-sub">Send a free item with your logo to people you pick. They claim it with their address; nobody is charged.</div>
        </div>
      </div>
      {sp.error && <p className="notice err">{sp.error}</p>}
      {sp.sent && (
        <p className="notice ok">
          Sent {sp.sent} gift{sp.sent === "1" ? "" : "s"}.{Number(sp.skipped) ? ` Skipped ${sp.skipped} who already have one waiting.` : ""} Each person got an email with their claim link.
        </p>
      )}
      {mode !== "live" && (
        <p className="notice">
          Supplier mode is <strong>{mode}</strong>: claimed gifts become orders you can review, but nothing is made or shipped until <code>SUPPLIER_MODE=live</code> and your CJ balance has funds.
        </p>
      )}

      <section className="a-card">
        <h2 className="a-h2">1. The design</h2>
        <div className="gift-designs">
          {Object.entries(GIFT_DESIGNS).map(([key, d]) => (
            <a key={key} href={`/brand/print/${d.file}`} target="_blank" rel="noreferrer" className={`gift-design gift-design-${key}`}>
              <img src={`/brand/print/${d.file}`} alt={d.label} />
              <span>{d.label}</span>
              <small>Open the print file (2000 px PNG)</small>
            </a>
          ))}
        </div>
      </section>

      {variants.length === 0 ? (
        <section className="a-card">
          <h2 className="a-h2">2. The item</h2>
          <p>
            No print-on-demand items yet. Find a printable water bottle or tumbler in the <Link href="/admin/suppliers/cj">CJ catalog</Link>, import it, then turn on
            personalization (photo) on the product. It shows up here once it can carry a logo.
          </p>
        </section>
      ) : (
        <form action={sendGiftsAction} className="a-card gift-form">
          <h2 className="a-h2">2. The item</h2>
          <div className="gift-items">
            {variants.map((v, i) => {
              const e = estimates[i];
              return (
                <label key={v.variantId} className={`gift-item${v.inStock ? "" : " is-out"}`}>
                  <input type="radio" name="variantId" value={v.variantId} defaultChecked={i === 0} disabled={!v.inStock} required />
                  {v.image ? <img src={v.image} alt="" /> : <span className="gift-noimg" />}
                  <span>
                    <strong>{v.label}</strong>
                    <small>
                      Item {v.productCents != null ? formatMoney(v.productCents) : "?"} · shipping {e.ca != null ? `CA ${formatMoney(e.ca)}` : "CA ?"}, {e.us != null ? `US ${formatMoney(e.us)}` : "US ?"}
                    </small>
                    <small>
                      <b>About {formatMoney(e.perGiftCents)} per gift</b>
                      {e.shippingKnown ? "" : " (shipping not quoted yet, $20 assumed)"}
                      {v.inStock ? "" : " · out of stock"}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
          <label className="gift-field">
            Design
            <select name="design" defaultValue="dark">
              {Object.entries(GIFT_DESIGNS).map(([k, d]) => (
                <option key={k} value={k}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <h2 className="a-h2">3. Who gets one</h2>
          {customers.length > 0 ? (
            <div className="gift-people">
              {customers.map((c, i) => (
                <label key={c.id}>
                  <input type="checkbox" name="pick" value={c.email} disabled={already.has(c.email)} />
                  <span>
                    #{i + 1} {c.name ? `${c.name} · ` : ""}
                    {c.email}
                  </span>
                  <small>{already.has(c.email) ? "already sent" : `joined ${timeAgo(c.createdAt)}`}</small>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted small">No users yet. Add people below.</p>
          )}
          <label className="gift-field">
            Anyone else (one per line: email, name)
            <textarea name="extra" rows={3} placeholder={"sam@example.com, Sam Lee\nAlex <alex@example.com>"} />
          </label>
          <label className="gift-field">
            Your note (in the email and on their claim page)
            <textarea name="message" rows={3} maxLength={500} placeholder="Thanks for being one of the first people to use Chit. Here's a little something from us." />
          </label>
          <label className="gift-field gift-budget">
            Budget for this send (USD)
            <input type="number" name="budget" min="1" step="1" defaultValue="100" required />
            <small>Nothing is sent if the gifts could cost more than this.</small>
          </label>
          <button className="a-btn a-btn-primary">Send gifts</button>
          <p className="muted small">
            Each claim becomes a $0 order in Orders. You approve it as usual, then CJ prints and ships it, paid from your CJ balance. Want to see one first? Send a gift to
            yourself.
          </p>
        </form>
      )}

      <h2 className="a-h2">Sent</h2>
      {gifts.length === 0 ? (
        <p className="muted small">No gifts sent yet.</p>
      ) : (
        gifts.map((g) => {
          const st = STATUS[g.status] ?? STATUS.SENT;
          const o = g.orderId ? orders.get(g.orderId) : null;
          return (
            <section key={g.id} className="a-card">
              <div className="a-card-head">
                <h3 className="a-h2">
                  {g.name ? `${g.name} · ` : ""}
                  {g.email}
                </h3>
                <span className={`chip-status ${st.tone}`}>{st.label}</span>
              </div>
              <p className="small">
                {variantLabel.get(g.productVariantId) ?? "Item"} · sent {timeAgo(g.createdAt)}
                {g.estimateCents ? ` · about ${formatMoney(g.estimateCents)}` : ""}
                {o ? (
                  <>
                    {" · "}
                    <Link href={`/admin/orders/${o.id}`}>order {o.number}</Link>
                  </>
                ) : null}
              </p>
              {g.status === "SENT" && (
                <div className="gift-row-actions">
                  <a href={giftUrl(g.token)} target="_blank" rel="noreferrer" className="small">
                    Claim link
                  </a>
                  <form action={cancelGiftAction}>
                    <input type="hidden" name="id" value={g.id} />
                    <button className="linkish small">Cancel</button>
                  </form>
                </div>
              )}
            </section>
          );
        })
      )}
    </>
  );
}
