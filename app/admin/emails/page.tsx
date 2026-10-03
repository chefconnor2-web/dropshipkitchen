import Link from "next/link";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { emailConfigured, senderAddress } from "@/lib/email";
import { Flash, timeAgo } from "@/components/admin";
import { sendTestEmailAction } from "@/app/admin/actions";

const KIND: Record<string, string> = {
  order_confirmation: "Order confirmed",
  order_shipped: "Shipped + tracking",
  order_refunded: "Refunded",
  merchant_new_order: "New order (to you)",
  test: "Test",
};

const STATUS: Record<string, { label: string; tone: string }> = {
  sent: { label: "Sent", tone: "tone-good" },
  failed: { label: "Failed", tone: "tone-bad" },
  not_configured: { label: "Not sent: no email key", tone: "tone-warn" },
};

export default async function EmailsPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { notice, error } = await searchParams;
  const logs = await prisma.emailLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  const on = emailConfigured();

  return (
    <>
      <div className="a-head">
        <div>
          <h1>Emails</h1>
          <div className="a-sub">Order confirmations, shipping updates and refunds sent to customers</div>
        </div>
      </div>
      <Flash notice={notice} error={error} />

      <section className="a-card">
        <div className="a-card-head">
          <h2 className="a-h2">Sending</h2>
          <span className={`chip-status ${on ? "tone-good" : "tone-warn"}`}>{on ? "On" : "Off"}</span>
        </div>
        {on ? (
          <p className="small">
            Sending from <code>{senderAddress()}</code>
            {config.email.storeEmail ? (
              <>
                . New-order alerts and replies go to <code>{config.email.storeEmail}</code>.
              </>
            ) : (
              <>. Set STORE_EMAIL to get new-order alerts and customer replies.</>
            )}
          </p>
        ) : (
          <p className="small">
            Emails are written and logged below but not delivered yet. To turn sending on, add <code>RESEND_API_KEY</code> (free at
            resend.com) in Railway → Variables. Optional: <code>EMAIL_FROM</code> once you verify your domain, and{" "}
            <code>STORE_EMAIL</code> for your own new-order alerts.
          </p>
        )}
        <form action={sendTestEmailAction} className="email-test">
          <label className="sr-only" htmlFor="test-to">
            Send a test email to
          </label>
          <input id="test-to" name="to" type="email" required placeholder="you@email.com" defaultValue={config.email.storeEmail} />
          <button className="a-btn a-btn-primary">Send test email</button>
        </form>
        {on && !config.email.from && (
          <p className="muted small">
            Until you verify a domain in Resend, it only delivers to the email address on your Resend account.
          </p>
        )}
      </section>

      <section className="a-card">
        <h2 className="a-h2">Latest emails</h2>
        {logs.length === 0 ? (
          <p className="muted small">None yet. One is written for every paid order.</p>
        ) : (
          <ul className="mini-list">
            {logs.map((l) => (
              <li key={l.id}>
                <div className="mini-row">
                  <span className="email-row-top">
                    <span className="strong">{KIND[l.kind] ?? l.kind}</span>
                    <span className={`chip-status ${STATUS[l.status]?.tone ?? "tone-muted"}`}>{STATUS[l.status]?.label ?? l.status}</span>
                  </span>
                  <span className="muted small">
                    {l.to} · {timeAgo(l.createdAt)}
                  </span>
                  {l.status === "failed" && l.error && <span className="small err-text">{l.error}</span>}
                  <span className="small">
                    <a href={`/admin/emails/${l.id}`} target="_blank" rel="noreferrer">
                      Preview
                    </a>
                    {l.orderId && (
                      <>
                        {" · "}
                        <Link href={`/admin/orders/${l.orderId}`}>Order</Link>
                      </>
                    )}
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
