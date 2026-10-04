// When to offer a freight quote instead of (or alongside) parcel shipping, and what happens when a shopper asks.
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { sendEmail } from "@/lib/email";

/** Offer freight when parcels cost more than this share of the goods, or more than this amount, or can't ship. */
export const FREIGHT_SHARE = 0.15;
export const FREIGHT_MIN_SHIPPING_CENTS = 1000_00;
export const FREIGHT_MIN_UNITS = 20;

export function suggestFreight(subtotalCents: number, shippingCents: number | null, units: number): boolean {
  if (shippingCents == null) return units >= FREIGHT_MIN_UNITS;
  return shippingCents >= FREIGHT_MIN_SHIPPING_CENTS || (subtotalCents > 0 && shippingCents / subtotalCents > FREIGHT_SHARE);
}

export interface FreightLine {
  title: string;
  option: string;
  quantity: number;
  unitCents: number;
  pid: string | null;
}

export async function createFreightRequest(r: {
  email: string;
  company?: string;
  notes?: string;
  country: string;
  postalCode?: string;
  items: FreightLine[];
  subtotalCents: number;
  parcelQuoteCents: number | null;
}) {
  const req = await prisma.freightRequest.create({
    data: {
      email: r.email,
      company: r.company || null,
      notes: r.notes ?? "",
      country: r.country,
      postalCode: r.postalCode ?? "",
      itemsJson: JSON.stringify(r.items),
      subtotalCents: r.subtotalCents,
      parcelQuoteCents: r.parcelQuoteCents,
    },
  });
  const lines = r.items.map((i) => `${i.quantity} × ${i.title}${i.option && !/^default$/i.test(i.option) ? ` (${i.option})` : ""} @ ${formatMoney(i.unitCents)}`).join("\n");
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  if (config.email.storeEmail) {
    await sendEmail({
      to: config.email.storeEmail,
      kind: "freight_request",
      subject: `Freight quote request · ${formatMoney(r.subtotalCents)} · ${r.country}`,
      text: `${r.email}${r.company ? ` (${r.company})` : ""} wants a freight quote to ${r.country} ${r.postalCode ?? ""}.\n\n${lines}\n\nGoods: ${formatMoney(r.subtotalCents)}\nParcel shipping would be: ${r.parcelQuoteCents != null ? formatMoney(r.parcelQuoteCents) : "not available"}\n\nNotes: ${r.notes || "-"}\n\nAdmin: ${config.siteUrl}/admin/freight`,
      html: `<p><strong>${esc(r.email)}</strong>${r.company ? ` (${esc(r.company)})` : ""} wants a freight quote to ${esc(r.country)} ${esc(r.postalCode ?? "")}.</p><pre>${esc(lines)}</pre><p>Goods: ${formatMoney(r.subtotalCents)}<br>Parcel shipping would be: ${r.parcelQuoteCents != null ? formatMoney(r.parcelQuoteCents) : "not available"}</p><p>Notes: ${esc(r.notes || "-")}</p><p><a href="${config.siteUrl}/admin/freight">Open in admin</a></p>`,
    });
  }
  await sendEmail({
    to: r.email,
    kind: "freight_request_received",
    subject: `We got your freight quote request`,
    text: `Thanks. We'll email you a freight quote for your order to ${r.country} within one business day.\n\n${lines}\n\n${config.storeName}`,
    html: `<p>Thanks. We'll email you a freight quote for your order to ${esc(r.country)} within one business day.</p><pre>${esc(lines)}</pre><p>${esc(config.storeName)}</p>`,
  });
  return req;
}
