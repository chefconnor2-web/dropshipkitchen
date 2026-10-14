// The rest of Chit in the MCP: paying in one tap (book with the customer's saved details and hand back a Stripe
// link), managing what they bought (orders, tracking, bookings, cancellations with a confirm step, sharing),
// their account (details, plan, billing) and company admin. Money still only moves on Stripe's page in the
// customer's own browser; cancellations always need a second call with the quote the customer agreed to.

import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { acting } from "@/lib/acting";
import { guarded, txt, UI, withCards, type Out, type Who } from "@/lib/mcp-kit";
import type { ViewCard } from "@/lib/mcp-cards";
import { getOffer } from "@/lib/duffel";
import { priceWithFee } from "@/lib/flights";
import { canCancelFlight, canHold, confirmFlightCancel, payHeldFlight, quoteFlightCancel, startFlightCheckout, startFlightHold, tripUrl, FLIGHT_STATUS } from "@/lib/flight-booking";
import { canCancelStay, cancelStay, startHotelCheckout, stayUrl } from "@/lib/hotel-booking";
import { offerCard } from "@/lib/hotels";
import { flightPrefill, getProfile, hotelPrefill, saveProfile } from "@/lib/traveller";
import { shareFromBooking, shareFromOffer } from "@/lib/shared-trips";
import { orderViewToken } from "@/lib/session";
import { aiAllowance } from "@/lib/membership";
import { billingPortalUrl, startFullSubscription, startLiteSubscription } from "@/lib/subscriptions";
import { expenseRows, invite, membershipOf, ROLES, setPolicy } from "@/lib/company";
import { formatMoney } from "@/lib/money";
import { flightPrice, stayPrice, type FlightCard, type HotelCard } from "@/lib/flights-shared";
import { parsePersonalizeConfig } from "@/lib/personalize-shared";

const isDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const abs = (p: string) => (p.startsWith("http") ? p : `${config.siteUrl}${p}`);

/** A Stripe link as a card with one Pay button. */
const payCard = (id: string, title: string, lines: string[], price: string | undefined, url: string, label = "Pay"): ViewCard => ({ kind: "trip", id, title, lines, price, actions: [{ label, url, primary: true }] });

/** Next's redirect() inside a server action, caught: the URL it was sending the browser to. */
function redirectTarget(e: unknown): string | null {
  const d = (e as { digest?: unknown })?.digest;
  if (typeof d !== "string" || !d.startsWith("NEXT_REDIRECT")) return null;
  return d.split(";")[2] ?? null;
}

/** The customer's own booking or order by its number: booked under their account, or with their email. */
async function mine<T extends { customerId: string | null; email: string | null }>(who: Who, row: T | null): Promise<T | null> {
  if (!row) return null;
  if (row.customerId === who.customerId) return row;
  const me = await prisma.customer.findUnique({ where: { id: who.customerId }, select: { email: true } });
  return me && row.email && row.email.toLowerCase() === me.email.toLowerCase() ? row : null;
}

/** Passenger fields from the tool (overrides for the lead traveller, and everyone after them). */
const passenger = z.object({
  title: z.enum(["mr", "ms", "mrs", "miss", "dr"]).optional(),
  gender: z.enum(["m", "f"]).optional(),
  given_name: z.string().max(40).optional().describe("As on the passport, English letters"),
  family_name: z.string().max(40).optional(),
  born_on: isDate.optional(),
  passport_number: z.string().max(20).optional(),
  passport_country: z.string().length(2).optional(),
  passport_expiry: isDate.optional(),
});

/** One-time confirm codes for hotel cancellations (a flight cancellation uses the airline's own quote id). */
const confirmCodes = new Map<string, { bookingId: string; until: number }>();

export function registerMoreTools(server: McpServer, who: Who) {
  const asMe = <T>(fn: () => Promise<T>, extra: Partial<Parameters<typeof acting.run>[0]> = {}) => acting.run({ customerId: who.customerId, ...extra }, fn);

  /* ---------- Phase 1: pay in one tap ---------- */

  server.registerTool(
    "book_flight",
    {
      title: "Book a flight",
      description:
        "Book a flight offer with the customer's saved details (My details) and return the Stripe pay link: no form. Pass passengers only for what's missing or for extra travellers (in the offer's order; the first is the customer). If details are missing the result says which; ask the customer, then call again (and offer update_my_details). hold=true holds the fare free with the airline when it allows (pay later with pay_held_flight).",
      inputSchema: {
        offer_id: z.string().regex(/^off_[A-Za-z0-9]+$/),
        passengers: z.array(passenger).max(9).default([]),
        email: z.string().max(254).optional(),
        phone: z.string().max(30).optional().describe("With country code"),
        hold: z.boolean().default(false),
        trip_id: z.string().max(40).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: UI,
    },
    guarded(who, "book_flight", async ({ offer_id, passengers, email, phone, hold, trip_id }) =>
      asMe(async () => {
        const offer = await getOffer(offer_id).catch(() => null);
        if (!offer) return txt("That fare is no longer available. Search again.", true);
        if (hold && !canHold(offer)) return txt("The airline needs this fare paid now; it can't be held. Book it without hold.", true);
        const price = priceWithFee(offer.total_amount);
        const form = new FormData();
        for (const [k, v] of Object.entries((await flightPrefill()).values)) form.set(k, v);
        passengers.forEach((p, i) => {
          const set = (k: string, v: string | undefined) => v && form.set(`${k}_${i}`, v);
          set("title", p.title);
          set("gender", p.gender);
          set("given", p.given_name);
          set("family", p.family_name);
          set("born", p.born_on);
          set("passport", p.passport_number);
          set("passport_country", p.passport_country?.toUpperCase());
          set("passport_expiry", p.passport_expiry);
        });
        if (email) form.set("email", email);
        if (phone) form.set("phone", phone);
        if (trip_id) form.set("chat", trip_id);
        const start = hold ? startFlightHold : startFlightCheckout;
        const r = await start({ offerId: offer_id, shownCents: price, form, customerId: who.customerId });
        if (!r.url) return txt({ booked: false, problem: r.error, travellers: offer.passengers.length, needs_passport: offer.passenger_identity_documents_required === true, how: "Ask the customer for what's missing and call book_flight again with passengers filled in." }, true);
        const card = JSON.parse((await prisma.flightBooking.findFirst({ where: { offerId: offer_id, customerId: who.customerId }, orderBy: { createdAt: "desc" }, select: { cardJson: true } }))?.cardJson ?? "null") as FlightCard | null;
        const route = card ? `${card.slices[0].from} → ${card.slices[card.slices.length - 1].to}` : "Flight";
        return withCards(
          { ok: true, [hold ? "held_url" : "pay_url"]: r.url, price: flightPrice({ priceCents: price, currency: offer.total_currency }), note: hold ? "Held with the airline. Pay before the deadline from that page (or pay_held_flight)." : "The customer pays on this Stripe page in their browser; the ticket is booked straight away and emailed." },
          [payCard(offer_id, hold ? `Fare held · ${route}` : `Pay for your flight · ${route}`, [hold ? "Held free with the airline. Pay before the deadline." : "Passengers filled in from your saved details."], flightPrice({ priceCents: price, currency: offer.total_currency }), r.url, hold ? "View hold" : "Pay")],
        );
      }),
    ),
  );

  server.registerTool(
    "book_hotel",
    {
      title: "Book a hotel",
      description: "Book a hotel offer (offer_id from search_hotels) with the customer's saved name, email and phone, and return the Stripe pay link. Pass guest details only when missing or for someone else.",
      inputSchema: { offer_id: z.string().max(2000), first_name: z.string().max(40).optional(), last_name: z.string().max(40).optional(), email: z.string().max(254).optional(), phone: z.string().max(30).optional(), trip_id: z.string().max(40).optional() },
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: UI,
    },
    guarded(who, "book_hotel", async ({ offer_id, first_name, last_name, email, phone, trip_id }) =>
      asMe(async () => {
        const card = await offerCard(offer_id);
        if (!card) return txt("That room is no longer available. Search again.", true);
        const form = new FormData();
        for (const [k, v] of Object.entries((await hotelPrefill()).values)) form.set(k, v);
        if (first_name) form.set("firstName", first_name);
        if (last_name) form.set("lastName", last_name);
        if (email) form.set("email", email);
        if (phone) form.set("phone", phone);
        if (trip_id) form.set("chat", trip_id);
        const r = await startHotelCheckout({ offerId: offer_id, shownCents: card.priceCents, form, customerId: who.customerId });
        if (!r.url) return txt({ booked: false, problem: r.error, how: "Ask the customer for what's missing, then call book_hotel again." }, true);
        return withCards({ ok: true, pay_url: r.url, price: stayPrice(card) }, [payCard(card.id, `Pay for your stay · ${card.name}`, [`${card.checkin} → ${card.checkout} · ${card.room}`], stayPrice(card), r.url)]);
      }),
    ),
  );

  server.registerTool(
    "pay_held_flight",
    { title: "Pay a held fare", description: "The Stripe pay link for a flight fare the customer is holding (booking number like CS-FL-…).", inputSchema: { number: z.string().max(40) }, annotations: { readOnlyHint: false, openWorldHint: true }, _meta: UI },
    guarded(who, "pay_held_flight", async ({ number }) => {
      const b = await mine(who, await prisma.flightBooking.findUnique({ where: { number } }));
      if (!b) return txt("That booking isn't one of the customer's.", true);
      const r = await payHeldFlight(b.id);
      if (!r.url) return txt(r.error ?? "Couldn't open payment.", true);
      return withCards({ pay_url: r.url }, [payCard(b.id, `Pay for held fare ${b.number}`, [], flightPrice({ priceCents: b.priceCents, currency: b.currency }), r.url)]);
    }),
  );

  server.registerTool(
    "checkout_cart",
    {
      title: "Check out the cart",
      description: "Re-check stock and shipping for the customer's Chit cart and return the Stripe pay link (they enter the delivery address on Stripe's page). Ships to the country given, else their saved address.",
      inputSchema: { country: z.string().length(2).optional().describe("2-letter country it ships to"), postal_code: z.string().max(12).optional(), express: z.boolean().default(false) },
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: UI,
    },
    guarded(who, "checkout_cart", async ({ country, postal_code, express }) => {
      const { checkout } = await import("@/app/(store)/actions");
      const shipTo = country ? { country: country.toUpperCase(), zip: postal_code ?? "", tier: express ? ("express" as const) : ("standard" as const) } : undefined;
      try {
        await asMe(() => checkout(), shipTo ? { shipTo } : {});
        return txt("Checkout didn't start. Try again.", true);
      } catch (e) {
        const to = redirectTarget(e);
        if (!to) throw e;
        if (to.startsWith("https://checkout.stripe.com") || to.includes("stripe.com")) return withCards({ pay_url: to, note: "The customer enters the delivery address and pays on Stripe's page." }, [payCard("cart", "Pay for your Chit cart", ["Delivery address on the next page."], undefined, to)]);
        const err = new URL(to, config.siteUrl).searchParams.get("error");
        return txt(err ?? (to === "/cart" ? "The cart is empty." : `Checkout stopped: ${to}`), true);
      }
    }),
  );

  server.registerTool(
    "payment_status",
    { title: "Did it go through?", description: "Status of one of the customer's flight or hotel bookings or product orders by its number: paid, booked (with confirmation code), cancelled… Call after they pay.", inputSchema: { number: z.string().max(40) }, annotations: { readOnlyHint: true, openWorldHint: false } },
    guarded(who, "payment_status", async ({ number }) => {
      const f = await mine(who, await prisma.flightBooking.findUnique({ where: { number } }));
      if (f) return txt({ kind: "flight", number, status: f.status, confirmation: f.bookingReference, paid: !!f.paidAt, hold_until: f.holdUntil?.toISOString(), link: await tripUrl(f) });
      const h = await mine(who, await prisma.hotelBooking.findUnique({ where: { number } }));
      if (h) return txt({ kind: "hotel", number, status: h.status, confirmation: h.confirmationCode, paid: !!h.paidAt, link: await stayUrl(h) });
      const o = await mine(who, await prisma.order.findUnique({ where: { number } }));
      if (o) return txt({ kind: "order", number, status: o.status, tracking: o.trackingStage ?? undefined, link: abs(`/orders/${o.number}?t=${await orderViewToken(o.id)}`) });
      return txt("No booking or order with that number for this customer.", true);
    }),
  );

  /* ---------- Phase 2: what they bought ---------- */

  server.registerTool(
    "my_orders",
    { title: "My orders", description: "The customer's product orders, newest first: number, status, total, items, tracking.", inputSchema: { limit: z.number().int().min(1).max(20).default(8) }, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: UI },
    guarded(who, "my_orders", async ({ limit }) => {
      const me = await prisma.customer.findUnique({ where: { id: who.customerId }, select: { email: true } });
      const orders = await prisma.order.findMany({ where: { OR: [{ customerId: who.customerId }, ...(me ? [{ email: me.email }] : [])], status: { not: "PENDING_PAYMENT" } }, orderBy: { createdAt: "desc" }, take: limit, include: { items: { select: { productTitle: true, variantName: true, quantity: true } } } });
      if (!orders.length) return txt({ orders: [], note: "No orders yet." });
      const rows = await Promise.all(
        orders.map(async (o) => ({
          number: o.number,
          date: o.createdAt.toISOString().slice(0, 10),
          status: o.status,
          total: formatMoney(o.subtotalCents + o.shippingCents),
          items: o.items.map((i) => `${i.quantity} × ${i.productTitle}${i.variantName && i.variantName !== "Default" ? ` (${i.variantName})` : ""}`),
          tracking: o.trackingStage ? `${o.trackingStage}${o.trackingStatus ? `: ${o.trackingStatus}` : ""}` : undefined,
          link: abs(`/orders/${o.number}?t=${await orderViewToken(o.id)}`),
        })),
      );
      return withCards({ orders: rows }, rows.map((r) => ({ kind: "trip", id: r.number, title: `Order ${r.number}`, subtitle: `${r.date} · ${r.status.toLowerCase().replace(/_/g, " ")}`, lines: [...r.items.slice(0, 5), r.tracking ?? ""].filter(Boolean), price: r.total, actions: [{ label: "View order", url: r.link, primary: true }] })), { title: "Your orders" });
    }),
  );

  server.registerTool(
    "track_order",
    { title: "Track an order", description: "Where one of the customer's orders is: tracking stage, the carrier's latest update, the delivery estimate and the history.", inputSchema: { number: z.string().max(40) }, annotations: { readOnlyHint: true, openWorldHint: false } },
    guarded(who, "track_order", async ({ number }) => {
      const o = await mine(who, await prisma.order.findUnique({ where: { number }, include: { trackingEvents: { orderBy: { at: "desc" }, take: 15 } } }));
      if (!o) return txt("No order with that number for this customer.", true);
      return txt({ number, status: o.status, stage: o.trackingStage, latest: o.trackingStatus, estimate_days: o.trackingEta, events: o.trackingEvents.map((e) => `${e.at.toISOString().slice(0, 16).replace("T", " ")} · ${e.stage}${e.detail ? ` · ${e.detail}` : ""}`), link: abs(`/orders/${o.number}?t=${await orderViewToken(o.id)}`) });
    }),
  );

  server.registerTool(
    "get_booking",
    { title: "Booking details", description: "Full details of one of the customer's flight or hotel bookings by number: flights or stay, travellers, status, confirmation, whether it can be cancelled.", inputSchema: { number: z.string().max(40) }, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: UI },
    guarded(who, "get_booking", async ({ number }) => {
      const f = await mine(who, await prisma.flightBooking.findUnique({ where: { number } }));
      if (f) {
        const card = JSON.parse(f.cardJson) as FlightCard;
        const pax = (JSON.parse(f.passengersJson) as Array<{ given_name: string; family_name: string }>).map((p) => `${p.given_name} ${p.family_name}`);
        const link = await tripUrl(f);
        const out = { kind: "flight", number, status: f.status, confirmation: f.bookingReference, airline: card.airline, flights: card.slices.map((s) => `${s.depart.slice(0, 16).replace("T", " ")} ${s.from} → ${s.to} (${s.segments.map((g) => g.flight).join(", ")})`), passengers: pax, paid: flightPrice({ priceCents: f.priceCents, currency: f.currency }), can_cancel: canCancelFlight(f, card), link };
        return withCards(out, [{ kind: "flight", id: f.id, title: `${card.slices[0].fromCity} → ${card.slices[card.slices.length - 1].toCity}`, subtitle: `${card.airline} · ${f.status.toLowerCase()}${f.bookingReference ? ` · ${f.bookingReference}` : ""}`, lines: out.flights, badges: pax, price: out.paid, actions: [{ label: "Open booking", url: link, primary: true }, ...(f.status === FLIGHT_STATUS.BOOKED ? [{ label: "Share with friends", tool: { name: "share_trip", args: { number } } }] : []), ...(out.can_cancel ? [{ label: "Cancel…", message: `Cancel my flight booking ${number}.` }] : [])] }]);
      }
      const h = await mine(who, await prisma.hotelBooking.findUnique({ where: { number } }));
      if (h) {
        const card = JSON.parse(h.cardJson) as HotelCard;
        const link = await stayUrl(h);
        const out = { kind: "hotel", number, status: h.status, confirmation: h.confirmationCode, hotel: card.name, address: card.address, dates: `${card.checkin} → ${card.checkout}`, room: card.room, guest: `${h.firstName} ${h.lastName}`, paid: stayPrice({ priceCents: h.priceCents, currency: h.currency }), refundable: card.refundable, can_cancel: canCancelStay(h, card), link };
        return withCards(out, [{ kind: "hotel", id: h.id, title: card.name, subtitle: `${h.status.toLowerCase()}${h.confirmationCode ? ` · ${h.confirmationCode}` : ""}`, lines: [out.dates, card.room], price: out.paid, actions: [{ label: "Open booking", url: link, primary: true }, ...(out.can_cancel ? [{ label: "Cancel…", message: `Cancel my hotel booking ${number}.` }] : [])] }]);
      }
      return txt("No booking with that number for this customer.", true);
    }),
  );

  server.registerTool(
    "cancel_flight",
    {
      title: "Cancel a flight",
      description:
        "Two steps. Without quote_id: asks the airline what the customer would get back (refund or credit) and returns a quote_id; show the customer exactly that. Only after they clearly say yes, call again with quote_id to cancel. Never cancel without their yes.",
      inputSchema: { number: z.string().max(40), quote_id: z.string().max(80).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guarded(who, "cancel_flight", async ({ number, quote_id }) => {
      const b = await mine(who, await prisma.flightBooking.findUnique({ where: { number } }));
      if (!b) return txt("That booking isn't one of the customer's.", true);
      if (!canCancelFlight(b, JSON.parse(b.cardJson))) return txt("This flight can't be cancelled online (already flown, cancelled, or not booked yet).", true);
      if (!quote_id) {
        const q = await quoteFlightCancel(b.id);
        if ("error" in q) return txt(q.error, true);
        return txt({ step: "confirm", number, quote_id: q.quoteId, refund: q.creditOnly ? "airline credit for a future flight, no money back" : formatMoney(q.refundCents), quote_expires: q.expiresAt, how: "Tell the customer exactly this. Only if they say yes, call cancel_flight again with this quote_id." });
      }
      const r = await confirmFlightCancel(b.id, quote_id);
      if ("error" in r) return txt(r.error, true);
      return txt({ cancelled: true, number, refunded: formatMoney(r.refundCents) });
    }),
  );

  server.registerTool(
    "cancel_hotel",
    {
      title: "Cancel a hotel",
      description: "Two steps. Without confirm_code: checks whether the stay can be cancelled and returns a confirm_code; tell the customer. Only after they clearly say yes, call again with confirm_code to cancel and refund.",
      inputSchema: { number: z.string().max(40), confirm_code: z.string().max(20).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guarded(who, "cancel_hotel", async ({ number, confirm_code }) => {
      const h = await mine(who, await prisma.hotelBooking.findUnique({ where: { number } }));
      if (!h) return txt("That booking isn't one of the customer's.", true);
      const card = JSON.parse(h.cardJson) as HotelCard;
      if (!canCancelStay(h, card)) return txt(card.refundable === false ? "This rate is non-refundable, so it can't be cancelled." : "This stay can't be cancelled online any more.", true);
      if (!confirm_code) {
        const code = randomBytes(4).toString("hex");
        confirmCodes.set(code, { bookingId: h.id, until: Date.now() + 15 * 60_000 });
        return txt({ step: "confirm", number, hotel: card.name, dates: `${card.checkin} → ${card.checkout}`, refund: `${stayPrice({ priceCents: h.priceCents, currency: h.currency })} back to their card (free cancellation rate)`, confirm_code: code, how: "Tell the customer. Only if they say yes, call cancel_hotel again with this confirm_code (valid 15 minutes)." });
      }
      const c = confirmCodes.get(confirm_code);
      if (!c || c.bookingId !== h.id || c.until < Date.now()) return txt("That confirm_code is wrong or expired. Start again without it.", true);
      confirmCodes.delete(confirm_code);
      const r = await cancelStay(h.id);
      if ("error" in r) return txt(r.error, true);
      return txt({ cancelled: true, number, refunded: formatMoney(r.refundCents) });
    }),
  );

  server.registerTool(
    "share_trip",
    { title: "Share a trip", description: "A link friends open to book the same flights for themselves (they pay separately): from a booked flight's number, or a flight offer_id.", inputSchema: { number: z.string().max(40).optional(), offer_id: z.string().max(80).optional() }, annotations: { readOnlyHint: false, openWorldHint: false } },
    guarded(who, "share_trip", async ({ number, offer_id }) => {
      let slug: string | null = null;
      if (number) {
        const b = await mine(who, await prisma.flightBooking.findUnique({ where: { number } }));
        if (!b) return txt("That booking isn't one of the customer's.", true);
        if (b.status !== FLIGHT_STATUS.BOOKED) return txt("Only booked flights can be shared.", true);
        slug = await shareFromBooking(b.id);
      } else if (offer_id && /^off_[A-Za-z0-9]+$/.test(offer_id)) slug = await shareFromOffer(offer_id);
      if (!slug) return txt("Give a booked flight's number or a flight offer_id.", true);
      return txt({ share_url: abs(`/trips/${slug}`), note: "Friends see the same flights at today's price and book their own seats." });
    }),
  );

  /* ---------- Phase 3: their account ---------- */

  server.registerTool(
    "my_details",
    { title: "My details", description: "The customer's saved traveller details (used to fill bookings): name, birth date, contact, passport (number masked), home address. Never card details.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } },
    guarded(who, "my_details", async () => {
      const p = await getProfile({ customerId: who.customerId, visitorId: null });
      if (!p) return txt({ saved: false, note: "Nothing saved yet. Ask the customer and call update_my_details." });
      const mask = (s?: string) => (s ? `•••${s.slice(-3)}` : undefined);
      return txt({ saved: true, ...p, passportNumber: mask(p.passportNumber) });
    }),
  );

  server.registerTool(
    "update_my_details",
    {
      title: "Save my details",
      description: "Save the customer's own traveller details they told you (bookings then fill themselves). Only what they said about themselves; an empty string clears a field. Never card details.",
      inputSchema: {
        title: z.enum(["mr", "ms", "mrs", "miss", "dr", ""]).optional(),
        gender: z.enum(["m", "f", ""]).optional(),
        givenName: z.string().max(40).optional(),
        familyName: z.string().max(40).optional(),
        bornOn: z.string().max(10).optional(),
        email: z.string().max(254).optional(),
        phone: z.string().max(30).optional(),
        passportNumber: z.string().max(20).optional(),
        passportCountry: z.string().max(2).optional(),
        passportExpiry: z.string().max(10).optional(),
        addressLine1: z.string().max(120).optional(),
        addressLine2: z.string().max(120).optional(),
        city: z.string().max(60).optional(),
        region: z.string().max(60).optional(),
        postalCode: z.string().max(12).optional(),
        country: z.string().max(2).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(who, "update_my_details", async (input) => {
      const saved = await saveProfile({ customerId: who.customerId, visitorId: null }, input as Record<string, unknown>);
      if (!saved) return txt("Couldn't save those details.", true);
      return txt({ saved: Object.keys(input), note: "Saved in My details. Confirm in one line without repeating passport numbers." });
    }),
  );

  server.registerTool(
    "my_plan",
    { title: "My plan", description: "The customer's Chit plan, how much Neon (AI) use they have left, and links to subscribe, upgrade or manage billing.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } },
    guarded(who, "my_plan", async () => {
      const a = await aiAllowance({ customerId: who.customerId, visitorId: null });
      return txt({ plan: a.plan ?? "free preview", subscriber: a.subscriber, neon_messages_left: a.remaining, of: a.limit, plans_page: abs("/plans"), how: a.subscriber ? "billing_portal manages or cancels the subscription." : "subscribe returns a Stripe link for Full or Lite." });
    }),
  );

  server.registerTool(
    "subscribe",
    { title: "Subscribe", description: "A Stripe link to subscribe to Chit Full (twice Lite's Neon use) or Lite. The customer pays on Stripe's page.", inputSchema: { plan: z.enum(["full", "lite"]) }, annotations: { readOnlyHint: false, openWorldHint: true }, _meta: UI },
    guarded(who, "subscribe", async ({ plan }) => {
      const c = await prisma.customer.findUniqueOrThrow({ where: { id: who.customerId }, select: { id: true, email: true, stripeCustomerId: true } });
      const url = plan === "full" ? await startFullSubscription(c) : await startLiteSubscription(c);
      return withCards({ pay_url: url }, [payCard(`sub_${plan}`, `Chit ${plan === "full" ? "Full" : "Lite"}`, ["Monthly. Cancel any time from billing."], undefined, url, "Subscribe")]);
    }),
  );

  server.registerTool(
    "billing_portal",
    { title: "Manage billing", description: "A Stripe link where the customer manages or cancels their subscription and sees invoices.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: true } },
    guarded(who, "billing_portal", async () => {
      const c = await prisma.customer.findUniqueOrThrow({ where: { id: who.customerId }, select: { stripeCustomerId: true } });
      if (!c.stripeCustomerId) return txt("They don't have a subscription yet. Use subscribe.", true);
      return txt({ url: await billingPortalUrl(c.stripeCustomerId) });
    }),
  );

  /* ---------- Phase 4: company admin ---------- */

  server.registerTool(
    "invite_member",
    { title: "Invite to company", description: "Admins: email someone an invitation to the company (role traveler, approver or admin).", inputSchema: { email: z.string().max(254), role: z.enum(ROLES).default("traveler") }, annotations: { readOnlyHint: false, openWorldHint: true } },
    guarded(who, "invite_member", async ({ email, role }) => {
      const r = await invite(who.customerId, email, role);
      return r.error ? txt(r.error, true) : txt({ invited: email, role });
    }),
  );

  server.registerTool(
    "edit_policy",
    { title: "Edit travel policy", description: "Admins: replace the company's travel policy (plain English) and optionally its report currency.", inputSchema: { policy: z.string().max(4000), currency: z.string().length(3).optional() }, annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false } },
    guarded(who, "edit_policy", async ({ policy, currency }) => {
      const me = await membershipOf(who.customerId);
      const r = await setPolicy(who.customerId, policy, currency ?? me?.company.currency ?? "USD");
      return r.error ? txt(r.error, true) : txt({ saved: true });
    }),
  );

  server.registerTool(
    "expense_report",
    { title: "Expense report", description: "Work expenses for a month (admins and approvers see the whole company, travelers their own): totals by person and category, each line, and the CSV link.", inputSchema: { month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM; default this month") }, annotations: { readOnlyHint: true, openWorldHint: false } },
    guarded(who, "expense_report", async ({ month }) => {
      const m = month ?? new Date().toISOString().slice(0, 7);
      const { rows, company, currency } = await expenseRows(who.customerId, m);
      const sum = (key: "person" | "category") => {
        const t = new Map<string, number>();
        for (const r of rows) t.set(`${r[key]} (${r.currency})`, (t.get(`${r[key]} (${r.currency})`) ?? 0) + Number(r.amount));
        return Object.fromEntries([...t].map(([k, v]) => [k, v.toFixed(2)]));
      };
      return txt({ company, month: m, report_currency: currency, lines: rows.length, by_person: sum("person"), by_category: sum("category"), rows: rows.slice(0, 60), csv: abs(`/api/company/expenses.csv?month=${m}`) });
    }),
  );

  /* ---------- Phase 5: personalized products ---------- */

  server.registerTool(
    "personalized_products",
    { title: "Personalized products", description: "Products Chit prints with the customer's own photo, logo or text, with links to design them (the designer is in Chit, where they upload the photo).", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: UI },
    guarded(who, "personalized_products", async () => {
      const products = await prisma.product.findMany({ where: { status: "PUBLISHED", personalizeJson: { not: null } }, include: { variants: { where: { enabled: true }, select: { priceCents: true } } }, take: 12 });
      const rows = products.flatMap((p) => {
        const cfg = parsePersonalizeConfig(p.personalizeJson);
        if (!cfg || !p.variants.length) return [];
        return [{ title: p.title, from: formatMoney(Math.min(...p.variants.map((v) => v.priceCents))), takes: [cfg.allowPhoto && "photo", cfg.allowText && "text"].filter(Boolean).join(" or "), design_url: abs(`/products/${p.slug}`) }];
      });
      return withCards({ products: rows }, rows.map((r) => ({ kind: "product", id: r.design_url, title: r.title, subtitle: `Your ${r.takes}`, lines: [], price: `from ${r.from}`, actions: [{ label: "Design it", url: r.design_url, primary: true }] })), { title: "Make it yours" });
    }),
  );
}

export type { Out };
