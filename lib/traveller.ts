// The shopper's details, so booking forms fill themselves. Two sources:
// - their saved traveller details (TravellerProfile): everything the flight, hotel and rental car forms ask for,
//   saved when they book (unless they untick "Save my details") or edited in My details in the chat. Stored
//   encrypted, per signed-in customer or else per browser. Never card details: payment is always typed at payment.
// - their account: email, and the name and phone saved from their last booking.

import { prisma } from "@/lib/db";
import { getMember, getMemberId } from "@/lib/session";
import { getVisitorId } from "@/lib/chat-session";
import { openToken, sealToken } from "@/lib/gmail";

/** Everything the booking forms ask for. All optional: saved as the shopper fills them in. */
export interface TravellerProfileData {
  title?: string;
  gender?: string;
  givenName?: string;
  familyName?: string;
  bornOn?: string;
  email?: string;
  phone?: string;
  passportNumber?: string;
  passportCountry?: string;
  passportExpiry?: string;
}

const FIELDS: Array<[keyof TravellerProfileData, RegExp, number]> = [
  ["title", /^(mr|ms|mrs|miss|dr)$/, 4],
  ["gender", /^(m|f)$/, 1],
  ["givenName", /^.{1,60}$/, 60],
  ["familyName", /^.{1,60}$/, 60],
  ["bornOn", /^\d{4}-\d{2}-\d{2}$/, 10],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 120],
  ["phone", /^[+\d][\d\s().-]{5,24}$/, 25],
  ["passportNumber", /^[A-Za-z0-9]{4,20}$/, 20],
  ["passportCountry", /^[A-Za-z]{2}$/, 2],
  ["passportExpiry", /^\d{4}-\d{2}-\d{2}$/, 10],
];

/** Keeps only well-formed fields ("" clears one). */
export function cleanProfile(input: Record<string, unknown>): Partial<Record<keyof TravellerProfileData, string>> {
  const out: Partial<Record<keyof TravellerProfileData, string>> = {};
  for (const [k, re, max] of FIELDS) {
    if (!(k in input)) continue;
    let v = String(input[k] ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    if (k === "passportCountry") v = v.toUpperCase();
    if (k === "title" || k === "gender") v = v.toLowerCase();
    if (v === "" || re.test(v)) out[k] = v;
  }
  return out;
}

export interface ProfileOwner {
  customerId: string | null;
  visitorId: string | null;
}
const whereOf = (o: ProfileOwner) => (o.customerId ? { customerId: o.customerId } : o.visitorId ? { visitorId: o.visitorId } : null);
export async function currentProfileOwner(): Promise<ProfileOwner> {
  const [customerId, visitorId] = await Promise.all([getMemberId(), getVisitorId()]);
  return { customerId, visitorId };
}

export async function getProfile(owner: ProfileOwner): Promise<TravellerProfileData | null> {
  const where = whereOf(owner);
  if (!where) return null;
  const row = await prisma.travellerProfile.findFirst({ where });
  if (!row) return null;
  try {
    return JSON.parse(await openToken(row.dataEnc)) as TravellerProfileData;
  } catch {
    return null;
  }
}

/** Merges what's given into the saved details ("" clears a field). Returns the saved details. */
export async function saveProfile(owner: ProfileOwner, input: Record<string, unknown>): Promise<TravellerProfileData | null> {
  const where = whereOf(owner);
  if (!where) return null;
  const merged: Record<string, string> = { ...((await getProfile(owner)) ?? {}) } as Record<string, string>;
  for (const [k, v] of Object.entries(cleanProfile(input))) {
    if (v) merged[k] = v;
    else delete merged[k];
  }
  const dataEnc = await sealToken(JSON.stringify(merged));
  const have = await prisma.travellerProfile.findFirst({ where, select: { id: true } });
  if (have) await prisma.travellerProfile.update({ where: { id: have.id }, data: { dataEnc } });
  else await prisma.travellerProfile.create({ data: { ...where, dataEnc } });
  return merged as TravellerProfileData;
}

export async function deleteProfile(owner: ProfileOwner): Promise<void> {
  const where = whereOf(owner);
  if (where) await prisma.travellerProfile.deleteMany({ where });
}

/** The flight form's fields for the lead passenger and contact, from saved details then the account. */
export async function flightPrefill(): Promise<{ values: Record<string, string>; from: "saved" | "account" | null }> {
  const [p, m] = await Promise.all([currentProfileOwner().then(getProfile), travellerPrefill()]);
  const values: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => v && (values[k] = v);
  put("title_0", p?.title);
  put("gender_0", p?.gender);
  put("given_0", p?.givenName ?? m?.firstName);
  put("family_0", p?.familyName ?? m?.lastName);
  put("born_0", p?.bornOn);
  put("passport_0", p?.passportNumber);
  put("passport_country_0", p?.passportCountry);
  put("passport_expiry_0", p?.passportExpiry);
  put("email", p?.email ?? m?.email);
  put("phone", p?.phone ?? m?.phone);
  return { values, from: p ? "saved" : m ? "account" : null };
}

/** The hotel form's lead guest and contact, from saved details then the account. */
export async function hotelPrefill(): Promise<{ values: Record<string, string>; from: "saved" | "account" | null }> {
  const [p, m] = await Promise.all([currentProfileOwner().then(getProfile), travellerPrefill()]);
  const values: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => v && (values[k] = v);
  put("firstName", p?.givenName ?? m?.firstName);
  put("lastName", p?.familyName ?? m?.lastName);
  put("email", p?.email ?? m?.email);
  put("phone", p?.phone ?? m?.phone);
  return { values, from: p ? "saved" : m ? "account" : null };
}

/** Booking forms: "Save my details" ticked → keep the lead traveller's details (only the fields the form had). */
export async function saveFromForm(form: FormData, kind: "flight" | "hotel"): Promise<void> {
  if (form.get("save_details") !== "on") return;
  const g = (k: string) => (form.has(k) ? String(form.get(k) ?? "") : undefined);
  const data: Record<string, string | undefined> =
    kind === "flight"
      ? {
          title: g("title_0"),
          gender: g("gender_0"),
          givenName: g("given_0"),
          familyName: g("family_0"),
          bornOn: g("born_0"),
          passportNumber: g("passport_0"),
          passportCountry: g("passport_country_0"),
          passportExpiry: g("passport_expiry_0"),
          email: g("email"),
          phone: g("phone"),
        }
      : { givenName: g("firstName"), familyName: g("lastName"), email: g("email"), phone: g("phone") };
  // Only what the form had, and never clear a saved field from a form that left it blank.
  const given = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== ""));
  await saveProfile(await currentProfileOwner(), given).catch((e) => console.error("[traveller] save failed:", e));
}

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
