// Sends email through Resend's HTTP API (no SDK) and logs every message, sent or not, to EmailLog.
// Sending never throws: a failed email must not break a payment, an approval or a refund.

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

export function emailConfigured(): boolean {
  return config.email.resendApiKey.length > 0;
}

export function senderAddress(): string {
  return config.email.from || `${config.storeName} <onboarding@resend.dev>`;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: string;
  orderId?: string;
}

export async function sendEmail(m: OutgoingEmail) {
  const base = { orderId: m.orderId ?? null, kind: m.kind, to: m.to, subject: m.subject, html: m.html, text: m.text };
  if (!emailConfigured()) {
    return prisma.emailLog.create({ data: { ...base, status: "not_configured", error: "RESEND_API_KEY is not set." } });
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${config.email.resendApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: senderAddress(),
        to: [m.to],
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(config.email.storeEmail ? { reply_to: config.email.storeEmail } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      return prisma.emailLog.create({ data: { ...base, status: "failed", error: `Resend ${res.status}: ${body.message ?? body.name ?? "error"}` } });
    }
    return prisma.emailLog.create({ data: { ...base, status: "sent", providerId: body.id ?? null } });
  } catch (e) {
    return prisma.emailLog.create({ data: { ...base, status: "failed", error: e instanceof Error ? e.message : String(e) } });
  }
}
