// Trips and email: what the shopper booked in this chat (flights and hotels they paid for), and email Neon
// writes for them (for example to a hotel's front desk: "please hold my package"). An email is sent only after
// the shopper approves the exact draft in the chat (Approve & next), from their own Gmail when connected, else
// from the store with replies going to the shopper and a copy to them.

import type Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { emailConfigured, sendEmail } from "@/lib/email";
import { gmailConfigured, gmailFor, sendFromGmail, type GmailOwner } from "@/lib/gmail";
import type { EmailDraftCard, FlightCard, HotelCard } from "@/lib/flights-shared";
import type { Connector, ConnectorContext, ToolResult } from "./types";
import { ownedBy } from "@/lib/chat-session";
import { tripsFor } from "@/lib/trips";
import { saveProfile } from "@/lib/traveller";

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
export const validEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && EMAIL.test(s.trim());
// A brake on mistakes: at most this many emails per chat (each one is still approved by the shopper).
const MAX_SENDS = 5;

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "save_my_details",
    description:
      "Save the shopper's own traveller details (and home address) they gave you in the chat (My details), so flight, hotel and rental car forms fill themselves next time. Only what they told you about themselves; an empty string clears a field. Never card details.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", enum: ["mr", "ms", "mrs", "miss", "dr", ""] },
        gender: { type: "string", enum: ["m", "f", ""] },
        givenName: { type: "string", description: "First and middle names" },
        familyName: { type: "string" },
        bornOn: { type: "string", description: "YYYY-MM-DD" },
        email: { type: "string" },
        phone: { type: "string" },
        passportNumber: { type: "string" },
        passportCountry: { type: "string", description: "2-letter country code" },
        passportExpiry: { type: "string", description: "YYYY-MM-DD" },
        addressLine1: { type: "string" },
        addressLine2: { type: "string" },
        city: { type: "string" },
        region: { type: "string", description: "Province or state" },
        postalCode: { type: "string" },
        country: { type: "string", description: "2-letter country code" },
      },
    },
  },
  {
    name: "my_trips",
    description:
      "All of the shopper's trips across their chats (any chat with a paid flight or hotel): each trip's itinerary in time order (flights, hotel check-in/out, Amazon packages and their delivery estimates, emails sent) and its receipts and confirmations (booking numbers, confirmation codes, amounts paid and refunded, status). Use it when they ask about their itinerary, trips, receipts or confirmation codes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "trip_bookings",
    description:
      "The flights and hotels the shopper has booked (paid for) from the cards in this chat: flight numbers and local departure/arrival times, hotel name, address, dates, confirmation code and the guest's name and email. Call it after they say they've booked, before writing to a hotel.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_email",
    description:
      "Draft an email for the shopper (for example to their hotel's front desk asking to hold a package until they arrive). The draft appears in the chat and is sent only when the shopper approves it; your turn pauses until then. Sent from their own Gmail when connected (the draft offers to connect it), otherwise from the store with replies going to them and a copy to them. Write it in the shopper's voice, signed with their name.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient address: the hotel's front desk, found on the hotel's own site or booking details, or an address the shopper told you to send it to instead (e.g. their own, to test).",
        },
        found_address: { type: "string", description: "The hotel front-desk address you found, when `to` is a different address the shopper asked for. Shown on the draft." },
        found_at: { type: "string", description: "Where you found found_address (the page's site, e.g. hotelname.com)." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text, signed with the shopper's name." },
      },
      required: ["to", "subject", "body"],
    },
  },
];

async function ownerOf(chatId: string): Promise<GmailOwner> {
  const c = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { customerId: true, visitorId: true } });
  return { customerId: c?.customerId ?? null, visitorId: c?.visitorId ?? null };
}

/** Flight and hotel cards shown in this chat (ids), so only bookings made from this chat are read. */
async function chatCards(chatId: string): Promise<{ flights: Set<string>; hotels: Set<string> }> {
  const c = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { uiJson: true } });
  const flights = new Set<string>();
  const hotels = new Set<string>();
  let ui: Array<{ role?: string; items?: Array<{ kind?: string; id?: string; offerId?: string }> }> = [];
  try {
    ui = JSON.parse(c?.uiJson ?? "[]");
  } catch {}
  for (const e of ui)
    for (const it of e.items ?? []) {
      if (it.kind === "flight" && it.id) flights.add(it.id);
      if (it.kind === "hotel") {
        if (it.id) hotels.add(it.id);
        if (it.offerId) hotels.add(it.offerId);
      }
    }
  return { flights, hotels };
}

export async function bookingsForChat(chatId: string) {
  const { flights, hotels } = await chatCards(chatId);
  const [fb, hb] = await Promise.all([
    flights.size ? prisma.flightBooking.findMany({ where: { offerId: { in: [...flights] }, status: "BOOKED" } }) : [],
    hotels.size ? prisma.hotelBooking.findMany({ where: { offerId: { in: [...hotels] }, status: "BOOKED" } }) : [],
  ]);
  // Hotel bookings store LiteAPI's offer id; cards saved before that used it as their id. Match either.
  return {
    flights: fb.map((b) => {
      const card = JSON.parse(b.cardJson) as FlightCard;
      const passengers = (JSON.parse(b.passengersJson) as Array<{ given_name?: string; family_name?: string }>).map((p) => `${p.given_name ?? ""} ${p.family_name ?? ""}`.trim());
      return {
        booking: b.number,
        reference: b.bookingReference,
        airline: card.airline,
        passengers,
        email: b.email,
        phone: b.phone,
        slices: card.slices.map((s) => ({
          from: `${s.fromCity} (${s.from})`,
          to: `${s.toCity} (${s.to})`,
          departLocal: s.depart,
          arriveLocal: s.arrive,
          flights: s.segments.map((g) => `${g.carrier} ${g.flight}`),
        })),
      };
    }),
    hotels: hb.map((b) => {
      const card = JSON.parse(b.cardJson) as HotelCard;
      return {
        booking: b.number,
        confirmation: b.confirmationCode,
        hotel: card.name,
        address: [card.address, card.city].filter(Boolean).join(", "),
        checkin: card.checkin,
        checkout: card.checkout,
        guest: `${b.firstName} ${b.lastName}`,
        email: b.email,
        phone: b.phone,
      };
    }),
  };
}

async function run(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult> {
  if (tool === "save_my_details") {
    const owner = await ownerOf(ctx.chatId);
    const saved = await saveProfile(owner, input);
    if (!saved) return { content: "Couldn't save: open the chat in their browser first.", isError: true };
    const keys = Object.keys(saved);
    return { content: JSON.stringify({ saved: keys, note: "Saved in My details (the sidebar). Booking forms fill themselves from it; card details are never saved. Confirm in one line without repeating passport numbers." }) };
  }
  if (tool === "my_trips") {
    const owner = await ownerOf(ctx.chatId);
    const trips = await tripsFor({ customerId: owner.customerId, where: ownedBy(owner.customerId, owner.visitorId) });
    if (!trips.length) return { content: JSON.stringify({ trips: [], note: "No trips yet: nothing booked and paid for in their chats." }) };
    // Booking-page links carry access tokens: the Trips menu shows them, the model doesn't need them.
    const plain = trips.map((t) => ({ ...t, receipts: t.receipts.map(({ href, ...r }) => ({ ...r, ...(r.kind === "amazon" && href ? { cartLink: href } : {}) })) }));
    return { content: JSON.stringify({ trips: plain, menu: "Every trip is in the Trips menu (the ✈️ button at the top of the chat, or Trips in the sidebar)." }) };
  }
  if (tool === "trip_bookings") {
    const b = await bookingsForChat(ctx.chatId);
    if (!b.flights.length && !b.hotels.length)
      return { content: JSON.stringify({ flights: [], hotels: [], note: "Nothing booked from this chat yet. Bookings show here once the shopper has paid (the card's Book button)." }) };
    return { content: JSON.stringify(b) };
  }
  if (tool === "send_email") {
    const to = String(input.to ?? "").trim();
    const subject = String(input.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const body = String(input.body ?? "").trim().slice(0, 5000);
    const found = String(input.found_address ?? "").trim();
    const foundAt = String(input.found_at ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!validEmail(to)) return { content: "That isn't a valid email address. Find the hotel's front desk address on its own website first.", isError: true };
    if (!subject || !body) return { content: "Give the email a subject and a body.", isError: true };
    const sent = (sendsByChat.get(ctx.chatId) ?? 0) + 1;
    if (sent > MAX_SENDS) return { content: "That's enough email from this chat for now.", isError: true };
    const owner = await ownerOf(ctx.chatId);
    // The shopper's own address for the copy and replies: their Gmail, else the email on their bookings.
    const b = await bookingsForChat(ctx.chatId);
    const shopperEmail = (await gmailFor(owner))?.email ?? b.hotels[0]?.email ?? b.flights[0]?.email ?? null;
    const id = `em_${randomBytes(6).toString("base64url")}`;
    const draft = async (): Promise<EmailDraftCard> => {
      const g = await gmailFor(owner);
      return {
        kind: "email-draft",
        id,
        to,
        cc: g ? [] : shopperEmail ? [shopperEmail] : [],
        subject,
        body,
        from: g?.email ?? null,
        ...(!g && gmailConfigured() ? { connectUrl: `${config.siteUrl}/api/google/connect?back=${encodeURIComponent(`/c/${ctx.chatId}`)}` } : {}),
        ...(validEmail(found) && found.toLowerCase() !== to.toLowerCase() ? { foundAddress: found, ...(foundAt ? { foundAt } : {}) } : {}),
        status: "draft",
        group: "Email",
      };
    };
    let card = await draft();
    if (!card.from && !emailConfigured()) return { content: "Email can't be sent yet: connect Gmail (the store's own email isn't set up either).", isError: true };
    ctx.show("Email", [card]);
    const w = await ctx.waitForShopper({ kind: "email", message: `Send this email to ${to}? Check it above, then approve.`, browser: null });
    if (w.outcome !== "resumed") {
      ctx.show("Email", [{ ...card, status: "not_sent", note: w.outcome === "expired" ? "Not sent: it waited too long." : "Not sent." }]);
      return { content: "The shopper didn't approve it, so it wasn't sent. Don't send it; ask if they want changes." };
    }
    // They may have connected Gmail while it waited.
    card = await draft();
    // A test send (the shopper had it sent to themselves): the received copy says where it would really go.
    const test = card.foundAddress ? `[Test: real recipient ${card.foundAddress}] ` : "";
    const outSubject = test ? `${test}${subject}` : subject;
    const outBody = test
      ? `TEST COPY. In real use this email goes to the hotel's front desk: ${card.foundAddress}${card.foundAt ? ` (found on ${card.foundAt})` : ""}.\n\n${body}`
      : body;
    try {
      if (card.from) {
        await sendFromGmail(owner, { to: [to], subject: outSubject, text: outBody });
      } else {
        const log = await sendEmail({ to, cc: card.cc, replyTo: shopperEmail ?? undefined, subject: outSubject, text: outBody, html: outBody.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!).replace(/\n/g, "<br>"), kind: "neon_email" });
        if (log.status !== "sent") throw new Error("The store's email couldn't send it.");
      }
    } catch (e) {
      ctx.show("Email", [{ ...card, status: "not_sent", note: e instanceof Error ? e.message : "Couldn't send it." }]);
      return { content: `It wasn't sent: ${e instanceof Error ? e.message : "an error"}. Tell the shopper.`, isError: true };
    }
    sendsByChat.set(ctx.chatId, sent);
    ctx.show("Email", [{ ...card, status: "sent", note: card.from ? `Sent from ${card.from}.` : `Sent from ${config.storeName}; replies go to ${shopperEmail ?? "the store"}.` }]);
    return { content: `Sent to ${to}${card.from ? ` from the shopper's Gmail (${card.from})` : " from the store (replies go to the shopper, who got a copy)"}. Tell them in one line.` };
  }
  return { content: `Unknown tool ${tool}.`, isError: true };
}

const sendsByChat = new Map<string, number>();

export const tripsConnector: Connector = {
  id: "trips",
  label: "Trips and email",
  // my_trips works without email; send_email says so itself when email isn't set up.
  enabled: () => true,
  prompt: () => `
Trips and email:
- When the shopper wants a package sent to where they're staying (e.g. "send this to my hotel" alongside a flight and hotel), always book the trip first and do the package at the end:
  1. The flight.
  2. A hotel whose check-in date is on or before the flight's arrival date (and that's open when they land).
  3. A rental car at the destination airport from the arrival date to the day they leave, when they ask for one: fill in Discover Cars' search in the live browser (rental_car_browse, then rental_car_act) and finish with rental_car_continue (or rental_car_link when the live browser isn't available).
  4. They book and pay for the flight and hotel themselves with the cards' Book buttons (the car on Discover Cars). Wait until they say they've booked, then call trip_bookings.
  5. Then the package, shipped to the hotel: find the item on Amazon (Prime only, unless nothing fits), add it to the cart, and finish with the Check out on Amazon link, telling them to ship it to "<their name>, guest arriving <date>, c/o <hotel name>, <hotel address>" and giving Amazon's estimated delivery date from your add results (an estimate; it depends on the address they enter). If it's estimated to arrive after they check out, say so and suggest something that arrives sooner.
  6. If no shop has it (nothing suitable on Amazon, or Amazon won't load), don't stall the trip: tell them their trip is booked, and that you can shop for it on Amazon or from wholesalers (the catalog) whenever they like and get it shipped to their accommodation.
  7. Last, once the package is on its way to the hotel, the email: find the hotel's front desk email on the hotel's own website (web search) and call send_email with a short, polite note from them: their name, booking confirmation, flight number and arrival time, that a package from Amazon is due around <date>, and a request to hold it at the front desk until they check in. It's sent only after they approve it in the chat.
- After any hotel is booked, even without a package, offer once: you can shop anything they need on Amazon or from wholesalers and have it shipped to their accommodation, waiting for them when they arrive.
- If the shopper asks you to send it to another address instead (say, their own, to test), still find the front desk's address first, then call send_email with to = their address, found_address = the front desk's and found_at = the site you found it on; the draft shows both. Mention the front desk address in your reply too.
- When the shopper tells you their own details to keep (name, birth date, email, phone, passport) or asks you to save their info, call save_my_details. It never holds card details: payment is always typed at payment.
- When they ask about their trips, itinerary, receipts or confirmation codes, call my_trips and answer from it (in a short, scannable list), and mention that it's all in the Trips menu (✈️ at the top of the chat).
- Never invent an email address, a booking, a time or a delivery date: use only what the tools returned.`,
  tools: TOOLS,
  run,
};
