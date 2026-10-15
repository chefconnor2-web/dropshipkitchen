// Emails to the store's owners about money: a booking that needs review, a dispute, a refund that failed. They go
// to STORE_EMAIL, or when that isn't set to the owners (OWNER_EMAILS, EXTRA_OWNER_EMAILS), so they're never lost.

import { config } from "@/lib/config";
import { sendEmail } from "@/lib/email";

export function ownerRecipients(): string[] {
  const list = [config.email.storeEmail, ...`${process.env.OWNER_EMAILS ?? ""},${process.env.EXTRA_OWNER_EMAILS ?? ""}`.split(",")].map((e) => (e ?? "").trim()).filter(Boolean);
  return [...new Set(list.map((e) => e.toLowerCase()))];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Emails every owner; never throws (an alert failing must not break the booking it's about). */
export async function ownerAlert(kind: string, subject: string, text: string): Promise<void> {
  const to = ownerRecipients();
  if (!to.length) {
    console.error(`[alert] no STORE_EMAIL or OWNER_EMAILS set; unsent: ${subject}`);
    return;
  }
  await Promise.all(to.map((addr) => sendEmail({ to: addr, kind, subject, text, html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${esc(text)}</pre>` }).catch((e) => console.error("[alert] send failed:", e))));
}

/** A short plain-text email to a customer (never throws). */
export async function customerNotice(to: string, kind: string, subject: string, text: string): Promise<void> {
  await sendEmail({ to, kind, subject, text, html: `<pre style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${esc(text)}</pre>` }).catch((e) => console.error("[email] send failed:", e));
}
