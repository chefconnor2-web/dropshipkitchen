// The signed-in shopper's details, so booking forms fill themselves: their account email, and the name and phone
// from their account (saved from their last booking when the account didn't have them yet). Passport numbers and
// dates of birth are never stored: they're typed per booking.

import { prisma } from "@/lib/db";
import { getMember } from "@/lib/session";

export interface TravellerPrefill {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** "Ana María Lee" → first "Ana María", last "Lee". */
export function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/** The signed-in shopper's details for a booking form, or null when signed out. */
export async function travellerPrefill(): Promise<TravellerPrefill | null> {
  const m = await getMember();
  if (!m) return null;
  return { ...splitName(m.name), email: m.email, phone: m.phone ?? "" };
}

/** After a booking: keep the lead traveller's name and phone on the account for next time. */
export async function rememberTraveller(customerId: string | null, t: { firstName: string; lastName: string; phone: string; email: string }) {
  if (!customerId) return;
  const m = await prisma.customer.findUnique({ where: { id: customerId }, select: { email: true, name: true } });
  // Only the account holder's own details: a booking for someone else (another email) doesn't overwrite them.
  if (!m || m.email.toLowerCase() !== t.email.toLowerCase()) return;
  const name = `${t.firstName} ${t.lastName}`.trim();
  await prisma.customer.update({ where: { id: customerId }, data: { phone: t.phone, ...(!m.name && name ? { name } : {}) } }).catch(() => {});
}
