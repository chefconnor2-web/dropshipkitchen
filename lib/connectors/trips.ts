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

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
export const validEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && EMAIL.test(s.trim());
// A brake on mistakes: at most this many emails per chat (each one is still approved by the shopper).
const MAX_SENDS = 5;

const TOOLS: Anthropic.Beta.BetaTool[] = [
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
        to: { type: "string", description: "Recipient address (e.g. the hotel's front desk). Only an address you found on the hotel's own site or booking details." },
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
      };
    }),
  };
}

async function run(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult> {
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
    try {
      if (card.from) {
        await sendFromGmail(owner, { to: [to], subject, text: body });
      } else {
        const log = await sendEmail({ to, cc: card.cc, replyTo: shopperEmail ?? undefined, subject, text: body, html: body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!).replace(/\n/g, "<br>"), kind: "neon_email" });
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
  enabled: () => gmailConfigured() || emailConfigured(),
  prompt: () => `
Trips and email:
- When the shopper wants a package sent to where they're staying (e.g. "send this to my hotel" alongside a flight and hotel), do it in order: find the flight; find a hotel whose check-in date is on or before the flight's arrival date (and that's open when they land); find the Amazon item and finish with the Check out on Amazon link, telling them to ship it to the hotel's address as "<their name>, guest arriving <date>, c/o <hotel name>, <hotel address>" and noting Amazon's estimated delivery date from your add results (say it's an estimate; it depends on the address they enter).
- They book and pay for the flight and hotel themselves with the cards' Book buttons. When they say they've booked, call trip_bookings, then find the hotel's front desk email on the hotel's own website (web search), and call send_email with a short, polite note from them: their name, booking confirmation, flight number and arrival time, that a package from Amazon is due around <date>, and a request to hold it at the front desk until they check in. It's sent only after they approve it in the chat.
- Never invent an email address, a booking, a time or a delivery date: use only what the tools returned.`,
  tools: TOOLS,
  run,
};
