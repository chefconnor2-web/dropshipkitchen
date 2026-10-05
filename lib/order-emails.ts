// Customer and merchant emails for an order's life: confirmed → shipped (with tracking) → delivered, or refunded.
// Each kind goes out once per order (a "sent" log row blocks repeats); the admin can resend on purpose.

import { prisma } from "@/lib/db";
import { config, storeInitials, stripeKeyProblem } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { sendEmail } from "@/lib/email";
import { orderViewToken } from "@/lib/session";
import { trackingLinks } from "@/lib/carriers";

export type OrderEmailKind =
  | "order_confirmation"
  | "order_shipped"
  | "order_delivered"
  | "order_refunded"
  | "merchant_new_order"
  | "merchant_tracking_issue";

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

function load(orderId: string) {
  return prisma.order.findUnique({ where: { id: orderId }, include: { items: true, parcels: { orderBy: { index: "asc" } } } });
}

function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Stripe test mode means no real money moved; say so in the subject so a test email is never mistaken for a real one. */
function testPrefix(): string {
  const k = config.stripe.secretKey;
  return !stripeKeyProblem() && (k.startsWith("sk_test_") || k.startsWith("rk_test_")) ? "[TEST] " : "";
}

/** The customer's order page; the token opens it without signing in (see orderViewToken). */
export function orderUrl(o: { number: string }, token: string): string {
  return `${config.siteUrl}/orders/${encodeURIComponent(o.number)}?t=${encodeURIComponent(token)}`;
}

/** Tracking numbers on an order: one, or one per parcel on a split order (stored comma-joined). */
function numbers(o: Loaded): string[] {
  return (o.cjTrackingNumber ?? "").split(",").map((n) => n.trim()).filter(Boolean);
}

function trackingBlock(o: Loaded): { html: string; text: string } {
  const split = o.parcels.length > 1 && o.parcels.some((p) => p.cjTrackingNumber);
  const rows = split
    ? o.parcels
        .filter((p) => p.cjTrackingNumber)
        .map((p) => ({ title: `Parcel ${p.index + 1} of ${o.parcels.length}`, links: trackingLinks({ number: p.cjTrackingNumber, lastMileCarrier: p.lastMileCarrier, lastMileNumber: p.lastMileNumber }) }))
    : numbers(o).slice(0, 1).map((n) => ({ title: "Tracking number", links: trackingLinks({ number: n, lastMileCarrier: o.lastMileCarrier, lastMileNumber: o.lastMileNumber }) }));
  const html = rows
    .map(
      (r) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6"><strong>${esc(r.title)}:</strong> <span style="font-family:monospace">${esc(r.links[r.links.length - 1]?.number)}</span><br>${r.links
        .map((l) => `<a href="${esc(l.href)}" style="color:#B43E0F">${esc(l.label)}</a>`)
        .join(" &nbsp;·&nbsp; ")}</p>`,
    )
    .join("");
  const text = rows.map((r) => `${r.title}: ${r.links[r.links.length - 1]?.number}\n${r.links.map((l) => `${l.label}: ${l.href}`).join("\n")}`).join("\n\n");
  return { html, text };
}

function address(o: Loaded): string[] {
  try {
    const s = JSON.parse(o.shippingAddressJson || "null") as { name?: string; address?: Record<string, string | null> } | null;
    const a = s?.address ?? {};
    return [s?.name, a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(", "), a.country].filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

function itemsTable(o: Loaded): { html: string; text: string } {
  const rows = o.items.map((i) => {
    const variant = [i.variantName && !/^default$/i.test(i.variantName) ? i.variantName : "", i.mysteryBoxName ? `from your ${i.mysteryBoxName}` : "", i.personalizationId ? "personalized" : ""].filter(Boolean).join(" · ");
    return { name: i.productTitle, variant, qty: i.quantity, total: formatMoney(i.customerPriceCents * i.quantity) };
  });
  const total = o.subtotalCents + o.shippingCents;
  const html = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px">
${rows
  .map(
    (r) => `<tr><td style="padding:10px 0;border-bottom:1px solid #E4DFD7">${esc(r.name)}${r.variant ? `<div style="color:#6B6760;font-size:13px">${esc(r.variant)}</div>` : ""}</td>
<td style="padding:10px 0;border-bottom:1px solid #E4DFD7;text-align:center;color:#6B6760;white-space:nowrap">× ${r.qty}</td>
<td style="padding:10px 0;border-bottom:1px solid #E4DFD7;text-align:right;white-space:nowrap">${esc(r.total)}</td></tr>`,
  )
  .join("")}
<tr><td colspan="2" style="padding:10px 0 2px;color:#6B6760">Subtotal</td><td style="padding:10px 0 2px;text-align:right">${esc(formatMoney(o.subtotalCents))}</td></tr>
<tr><td colspan="2" style="padding:2px 0;color:#6B6760">Shipping</td><td style="padding:2px 0;text-align:right">${o.shippingCents ? esc(formatMoney(o.shippingCents)) : "Free"}</td></tr>
<tr><td colspan="2" style="padding:8px 0;font-weight:700">Total</td><td style="padding:8px 0;text-align:right;font-weight:700">${esc(formatMoney(total))}</td></tr>
</table>`;
  const text = [
    ...rows.map((r) => `${r.name}${r.variant ? ` (${r.variant})` : ""} × ${r.qty}  ${r.total}`),
    `Subtotal ${formatMoney(o.subtotalCents)}`,
    `Shipping ${o.shippingCents ? formatMoney(o.shippingCents) : "Free"}`,
    `Total ${formatMoney(total)}`,
  ].join("\n");
  return { html, text };
}

function layout(title: string, intro: string, body: string, cta?: { label: string; href: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#EEEBE4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1D1C1A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#15171A;padding:18px 24px;color:#EEEBE4;font-weight:700;letter-spacing:2px;text-transform:uppercase;font-size:15px">
<span style="display:inline-block;background:#E8551C;color:#fff;border-radius:4px;padding:2px 8px;margin-right:8px">${esc(storeInitials())}</span>${esc(config.storeName)}</td></tr>
<tr><td style="padding:28px 24px 8px"><h1 style="margin:0 0 10px;font-size:24px;line-height:1.2">${esc(title)}</h1>
<p style="margin:0 0 18px;color:#4B4F55;font-size:15px;line-height:1.55">${intro}</p>${body}
${cta ? `<p style="margin:24px 0 8px"><a href="${esc(cta.href)}" style="display:inline-block;background:#E8551C;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px">${esc(cta.label)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:16px 24px 24px;color:#6B6760;font-size:12.5px;line-height:1.5">Questions? Just reply to this email.<br>${esc(config.storeName)} · ${esc(config.siteUrl.replace(/^https?:\/\//, ""))}</td></tr>
</table></td></tr></table></body></html>`;
}

function render(kind: OrderEmailKind, o: Loaded, token: string): { to: string; subject: string; html: string; text: string } | null {
  const items = itemsTable(o);
  const addr = address(o);
  const addrHtml = addr.length
    ? `<p style="margin:18px 0 0;font-size:14px;line-height:1.5"><strong>Shipping to</strong><br>${addr.map(esc).join("<br>")}</p>`
    : "";
  const link = orderUrl(o, token);
  const p = testPrefix();
  const first = (o.customerName || "").split(" ")[0];
  const hi = first ? `Hi ${esc(first)}, ` : "";

  if (kind === "order_confirmation") {
    if (!o.email) return null;
    return {
      to: o.email,
      subject: `${p}Order ${o.number} confirmed`,
      html: layout(
        "Thanks, we’ve got your order.",
        `${hi}your payment went through and order <strong>${esc(o.number)}</strong> is being prepared. We’ll email you the tracking number as soon as it ships.`,
        items.html + addrHtml,
        { label: "View your order", href: link },
      ),
      text: `${first ? `Hi ${first}, ` : ""}thanks for your order ${o.number}. Payment received; we'll email tracking as soon as it ships.\n\n${items.text}\n\n${addr.length ? `Shipping to:\n${addr.join("\n")}\n\n` : ""}View your order: ${link}`,
    };
  }
  if (kind === "order_shipped") {
    if (!o.email || !o.cjTrackingNumber) return null;
    const t = trackingBlock(o);
    const several = numbers(o).length > 1;
    return {
      to: o.email,
      subject: `${p}Order ${o.number} has shipped`,
      html: layout(
        "Your order is on its way.",
        `${hi}order <strong>${esc(o.number)}</strong> has shipped${several ? ` in ${numbers(o).length} parcels` : ""}. Follow every step on your order page; we update it automatically as the carrier scans your package. The first scan can take a day or two to appear.`,
        t.html + items.html + addrHtml,
        { label: "Track your order", href: link },
      ),
      text: `Order ${o.number} has shipped.\nTrack every step: ${link}\n\n${t.text}\n\n${items.text}`,
    };
  }
  if (kind === "order_delivered") {
    if (!o.email) return null;
    return {
      to: o.email,
      subject: `${p}Order ${o.number} was delivered`,
      html: layout(
        "Delivered.",
        `${hi}the carrier reports order <strong>${esc(o.number)}</strong> as delivered. If you can’t find it, check with neighbours or your building’s mailroom, then just reply to this email and we’ll sort it out.`,
        items.html + addrHtml,
        { label: "View your order", href: link },
      ),
      text: `The carrier reports order ${o.number} as delivered. Can't find it? Reply to this email and we'll sort it out.\n\n${items.text}\n\nView your order: ${link}`,
    };
  }
  if (kind === "merchant_tracking_issue") {
    if (!config.email.storeEmail) return null;
    const admin = `${config.siteUrl}/admin/orders/${o.id}`;
    const status = o.trackingStatus || o.parcels.find((x) => x.trackingStage === "exception")?.trackingStatus || "a delivery problem";
    return {
      to: config.email.storeEmail,
      subject: `${p}Delivery problem on order ${o.number}`,
      html: layout(
        "A parcel needs attention",
        `The carrier reports <strong>${esc(status)}</strong> for order <strong>${esc(o.number)}</strong> (${esc(o.customerName || o.email || "customer")}). Reaching out before they ask builds trust.`,
        trackingBlock(o).html,
        { label: "Open in admin", href: admin },
      ),
      text: `The carrier reports "${status}" for order ${o.number}. ${admin}`,
    };
  }
  if (kind === "order_refunded") {
    if (!o.email) return null;
    const total = formatMoney(o.subtotalCents + o.shippingCents);
    return {
      to: o.email,
      subject: `${p}Order ${o.number} cancelled and refunded`,
      html: layout(
        "Your order was cancelled and refunded.",
        `${hi}we couldn’t fulfil order <strong>${esc(o.number)}</strong>, so we cancelled it and refunded the full <strong>${esc(total)}</strong> to your original payment method. Refunds usually appear within 5–10 business days. Sorry for the trouble.`,
        items.html,
      ),
      text: `Order ${o.number} was cancelled and the full ${total} refunded to your original payment method (5–10 business days).\n\n${items.text}`,
    };
  }
  if (kind === "merchant_new_order") {
    if (!config.email.storeEmail) return null;
    const admin = `${config.siteUrl}/admin/orders/${o.id}`;
    return {
      to: config.email.storeEmail,
      subject: `${p}New order ${o.number} · ${formatMoney(o.subtotalCents + o.shippingCents)} · needs approval`,
      html: layout(
        "New order to approve",
        `${esc(o.customerName || o.email || "A customer")} paid for order <strong>${esc(o.number)}</strong>. Open it to place it with CJ or decline it.`,
        items.html + addrHtml,
        { label: "Open in admin", href: admin },
      ),
      text: `New order ${o.number} from ${o.customerName || o.email}. Approve it: ${admin}\n\n${items.text}`,
    };
  }
  return null;
}

/** Send one order email unless that kind already went out (pass force to resend). Never throws. */
export async function sendOrderEmail(orderId: string, kind: OrderEmailKind, opts: { force?: boolean } = {}) {
  try {
    const o = await load(orderId);
    if (!o) return null;
    if (!opts.force && (await prisma.emailLog.findFirst({ where: { orderId, kind, status: "sent" } }))) return null;
    const m = render(kind, o, await orderViewToken(o.id));
    if (!m) return null;
    return await sendEmail({ ...m, kind, orderId });
  } catch (e) {
    console.error(`[email] ${kind} for ${orderId} failed:`, e);
    return null;
  }
}

/** A sample email to prove delivery works, using the newest real order when there is one. */
export async function sendTestEmail(to: string) {
  const o = await prisma.order.findFirst({ where: { status: { not: "PENDING_PAYMENT" } }, orderBy: { createdAt: "desc" }, include: { items: true, parcels: true } });
  const body = o
    ? itemsTable(o).html
    : `<p style="font-size:15px">No orders yet, so this is a plain test. Real order emails include the items, totals and shipping address.</p>`;
  return sendEmail({
    to,
    kind: "test",
    subject: `[TEST] ${config.storeName} email is working`,
    html: layout("Email is working.", `This is a test from your ${esc(config.storeName)} admin.${o ? ` Below is how order ${esc(o.number)} looks in a customer email.` : ""}`, body),
    text: `This is a test email from your ${config.storeName} admin.`,
  });
}
