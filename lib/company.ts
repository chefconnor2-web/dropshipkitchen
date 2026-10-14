// Company travel (internal proof of concept): a company, its people (admin, approver, traveler), a travel
// policy in plain English that Neon follows when booking work trips, and work expenses: receipts in any
// format that Neon reads and logs, plus everything booked in Chit for chats tagged as work. Admins export it
// all as CSV for their accounting tool.

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { sendEmail } from "@/lib/email";
import { tripsFor } from "@/lib/trips";

export const ROLES = ["admin", "approver", "traveler"] as const;
export type Role = (typeof ROLES)[number];
export const CATEGORIES = ["flight", "hotel", "car", "meals", "taxi", "transit", "lodging", "supplies", "other"] as const;

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The company this customer belongs to, with their role, or null. */
export async function membershipOf(customerId: string | null | undefined) {
  if (!customerId) return null;
  const m = await prisma.companyMember.findUnique({ where: { customerId }, include: { company: true } });
  return m ? { role: m.role as Role, company: m.company } : null;
}

export async function createCompany(customerId: string, name: string): Promise<{ error?: string }> {
  const n = name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (n.length < 2) return { error: "Give the company a name." };
  if (await membershipOf(customerId)) return { error: "You're already in a company." };
  await prisma.company.create({ data: { name: n, members: { create: { customerId, role: "admin" } } } });
  return {};
}

/** Emails an invitation link; the invitee signs in with that email to join. Admins only. */
export async function invite(adminId: string, email: string, role: string): Promise<{ error?: string }> {
  const me = await membershipOf(adminId);
  if (me?.role !== "admin") return { error: "Only admins can invite people." };
  const to = email.trim().toLowerCase();
  if (!EMAIL.test(to) || to.length > 254) return { error: "Enter a valid email." };
  const r = (ROLES as readonly string[]).includes(role) ? role : "traveler";
  const existing = await prisma.customer.findUnique({ where: { email: to }, select: { id: true } });
  if (existing && (await prisma.companyMember.findUnique({ where: { customerId: existing.id } }))) return { error: "That person is already in a company." };
  const token = randomBytes(24).toString("base64url");
  await prisma.companyInvite.create({ data: { companyId: me.company.id, email: to, role: r, tokenHash: sha256(token) } });
  const link = `${config.siteUrl}/company/join?t=${token}`;
  const text = `You're invited to ${me.company.name} on ${config.storeName} as ${r === "admin" ? "an admin" : `a ${r}`}.\n\nBook work trips in a chat with Neon: it follows your company's travel policy, and your receipts and bookings go straight to your company's expenses.\n\nJoin: ${link}\n\nSign in with this email (${to}) to accept.`;
  await sendEmail({ to, kind: "company_invite", subject: `Join ${me.company.name} on ${config.storeName}`, text, html: `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>").replace(link, `<a href="${link}">${link}</a>`)}</p>` });
  return {};
}

/** Accepts an invitation: the signed-in customer's email must be the one invited. */
export async function acceptInvite(token: string, customer: { id: string; email: string }): Promise<{ error?: string; company?: string }> {
  const inv = await prisma.companyInvite.findUnique({ where: { tokenHash: sha256(token) }, include: { company: true } });
  if (!inv || inv.acceptedAt) return { error: "This invitation has been used or doesn't exist. Ask your admin for a new one." };
  if (inv.email !== customer.email.toLowerCase()) return { error: `This invitation is for ${inv.email}. Sign in with that email to accept it.` };
  if (await membershipOf(customer.id)) return { error: "You're already in a company." };
  await prisma.$transaction([
    prisma.companyMember.create({ data: { companyId: inv.companyId, customerId: customer.id, role: inv.role } }),
    prisma.companyInvite.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
  ]);
  return { company: inv.company.name };
}

export async function setPolicy(adminId: string, policy: string, currency: string): Promise<{ error?: string }> {
  const me = await membershipOf(adminId);
  if (me?.role !== "admin") return { error: "Only admins can change the policy." };
  const cur = /^[A-Za-z]{3}$/.test(currency.trim()) ? currency.trim().toUpperCase() : me.company.currency;
  await prisma.company.update({ where: { id: me.company.id }, data: { policy: policy.trim().slice(0, 4000), currency: cur } });
  return {};
}

export interface ExpenseInput {
  merchant: string;
  category: string;
  amount: number;
  currency: string;
  tax?: number | null;
  spentOn: string;
  note?: string;
}

/** Validates and saves one expense for this customer (and their company, if any). */
export async function logExpense(customerId: string, chatId: string | null, e: ExpenseInput): Promise<{ error?: string; id?: string; company?: string | null }> {
  const merchant = String(e.merchant ?? "").trim().slice(0, 120);
  if (!merchant) return { error: "The receipt needs a merchant name." };
  const amount = Number(e.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return { error: "The amount must be a positive number." };
  const currency = String(e.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { error: "Give the currency as a 3-letter code (USD, CAD, EUR…)." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.spentOn ?? ""))) return { error: "Give the date as YYYY-MM-DD." };
  const tax = e.tax == null || e.tax === 0 ? null : Number(e.tax);
  const category = (CATEGORIES as readonly string[]).includes(e.category) ? e.category : "other";
  const me = await membershipOf(customerId);
  const row = await prisma.expense.create({
    data: {
      companyId: me?.company.id ?? null,
      customerId,
      chatId,
      merchant,
      category,
      amountCents: Math.round(amount * 100),
      currency,
      taxCents: tax != null && Number.isFinite(tax) && tax >= 0 ? Math.round(tax * 100) : null,
      spentOn: e.spentOn,
      note: String(e.note ?? "").trim().slice(0, 300),
    },
  });
  return { id: row.id, company: me?.company.name ?? null };
}

export interface ExpenseRow {
  date: string;
  person: string;
  merchant: string;
  category: string;
  amount: string;
  currency: string;
  tax: string;
  trip: string;
  source: "receipt" | "booking";
  note: string;
}

const money = (cents: number) => (cents / 100).toFixed(2);

/** "$412.30 CAD" / "CA$1,204" / "USD 99.00" → amount and currency, or null. */
export function parseMoney(s: string | null | undefined, fallback = "USD"): { amount: number; currency: string } | null {
  if (!s) return null;
  const n = /(\d[\d,]*(?:\.\d+)?)/.exec(s);
  if (!n) return null;
  const amount = Number(n[1].replace(/,/g, ""));
  const code = /\b([A-Z]{3})\b/.exec(s)?.[1] ?? (/CA\$/.test(s) ? "CAD" : /€/.test(s) ? "EUR" : /£/.test(s) ? "GBP" : fallback);
  return Number.isFinite(amount) ? { amount, currency: code } : null;
}

/**
 * Every work expense in scope: logged receipts, plus what was booked in Chit (flights, hotels, cars) in chats
 * tagged as work. Admins and approvers see the whole company; travelers see their own. `month` is YYYY-MM.
 */
export async function expenseRows(viewerId: string, month?: string): Promise<{ rows: ExpenseRow[]; company: string | null; currency: string }> {
  const me = await membershipOf(viewerId);
  const people = me && me.role !== "traveler" ? await prisma.companyMember.findMany({ where: { companyId: me.company.id }, select: { customerId: true } }) : [{ customerId: viewerId }];
  const ids = people.map((p) => p.customerId);
  const customers = new Map((await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })).map((c) => [c.id, c.name || c.email]));
  const inMonth = (d: string) => !month || d.startsWith(month);
  const rows: ExpenseRow[] = [];
  const logged = await prisma.expense.findMany({ where: { customerId: { in: ids } }, orderBy: { spentOn: "asc" } });
  const chatTitles = new Map((await prisma.assistantChat.findMany({ where: { id: { in: logged.map((e) => e.chatId).filter((x): x is string => !!x) } }, select: { id: true, title: true } })).map((c) => [c.id, c.title]));
  for (const e of logged)
    if (inMonth(e.spentOn))
      rows.push({ date: e.spentOn, person: customers.get(e.customerId) ?? "", merchant: e.merchant, category: e.category, amount: money(e.amountCents), currency: e.currency, tax: e.taxCents != null ? money(e.taxCents) : "", trip: e.chatId ? (chatTitles.get(e.chatId) ?? "") : "", source: "receipt", note: e.note });
  // Booked in Chit, in work chats: each receipt with an amount.
  for (const id of ids) {
    const trips = await tripsFor({ customerId: id, where: { customerId: id, work: true } });
    for (const t of trips)
      for (const r of t.receipts) {
        if (r.kind === "email" || r.kind === "amazon") continue;
        const m = parseMoney(r.amount);
        if (!m) continue;
        const date = (r.at ?? t.start ?? "").slice(0, 10);
        if (!inMonth(date)) continue;
        rows.push({ date, person: customers.get(id) ?? "", merchant: r.title, category: r.kind, amount: m.amount.toFixed(2), currency: m.currency, tax: "", trip: t.title, source: "booking", note: [r.status, r.confirmation ? `Confirmation ${r.confirmation}` : ""].filter(Boolean).join(" · ") });
      }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.person.localeCompare(b.person));
  return { rows, company: me?.company.name ?? null, currency: me?.company.currency ?? "USD" };
}

/** RFC 4180 CSV, ready for QuickBooks, Xero or Expensify uploads. */
export function toCsv(rows: ExpenseRow[]): string {
  const head = ["Date", "Person", "Merchant", "Category", "Amount", "Currency", "Tax", "Trip", "Source", "Note"];
  const cell = (v: string) => (/[",\n\r]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? "'" : "") + v.replace(/"/g, '""')}"` : v);
  return [head, ...rows.map((r) => [r.date, r.person, r.merchant, r.category, r.amount, r.currency, r.tax, r.trip, r.source, r.note])].map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n";
}
