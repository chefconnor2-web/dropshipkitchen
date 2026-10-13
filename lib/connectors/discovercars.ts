// Rental cars through Discover Cars, as an affiliate: Neon shows a card with where and when, and a button to
// Discover Cars (our affiliate link), where the shopper compares cars from rental companies and books. They pay
// Discover Cars directly; we earn a commission on completed rentals. No payment, stock or risk on our side.
//
// With the live browser (lib/browser.ts) on, Neon can also open Discover Cars in it and fill in the search
// (place, dates, times) while the shopper watches, compare the cars, then hand over one "Continue on Discover
// Cars" link to that page, with Neon's most economical pick. "Book it for me": Neon opens the pick, fills in the
// driver details the shopper approved in the chat, and takes it to the payment step; the shopper enters their
// card and taps Book themselves in the live browser. Neon never types or sees card details (the payment page is
// left out of its screenshots).
//
// DISCOVERCARS_AFFILIATE_ID  the a_aid from the Discover Cars affiliate dashboard
// DISCOVERCARS_BASE_URL      tests only (a local stand-in for the site)

import type Anthropic from "@anthropic-ai/sdk";
import { createHash, randomBytes } from "node:crypto";
import type { BrowserCard, CarRentalCard } from "@/lib/flights-shared";
import { BrowserError, browserApi, browserConfigured, chatBrowserId, inBrowser, isBusy, type PageState } from "@/lib/browser";
import type { Connector, ConnectorContext, ToolResult } from "./types";
import { bookingsForChat } from "./trips";
import { getProfile } from "@/lib/traveller";
import { chatShown } from "@/lib/trips";
import { prisma } from "@/lib/db";
import { processSingleton } from "@/lib/singleton";
import type { PendingKind } from "@/lib/run-shared";

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

const base = () => (process.env.DISCOVERCARS_BASE_URL || "https://www.discovercars.com").replace(/\/+$/, "");
const SITE = "discovercars.com";

export function discoverCarsConfigured(): boolean {
  return !!process.env.DISCOVERCARS_AFFILIATE_ID?.trim();
}

// Location pages, as the Discover Cars landing page generator makes them: /<country>/<city>/<airport code>,
// e.g. /canada/vancouver/yvr. Only countries whose page names we've confirmed get a location page; anywhere
// else opens the search on the home page (a guessed page name could be a dead link).
const COUNTRY_PAGES: Record<string, string> = { CA: "canada" };

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Our affiliate link: the location page when we know its address, else the home page. */
export function discoverCarsUrl(where?: { countryCode?: string; city?: string; airport?: string }): string {
  const q = new URLSearchParams({ a_aid: process.env.DISCOVERCARS_AFFILIATE_ID?.trim() ?? "" });
  const country = where?.countryCode ? COUNTRY_PAGES[where.countryCode.toUpperCase()] : undefined;
  const city = where?.city ? slug(where.city) : "";
  if (!country || !city) return `${base()}/?${q}`;
  const airport = /^[A-Za-z]{3}$/.test(where?.airport ?? "") ? `/${where!.airport!.toLowerCase()}` : "";
  return `${base()}/${country}/${city}${airport}?${q}`;
}

/** The page the shopper should continue on: a Discover Cars page from the live browser, with our a_aid on it. */
export function continueUrl(pageUrl: string | null | undefined, fallback: string): string {
  try {
    const u = new URL(String(pageUrl));
    const b = new URL(base());
    if (u.protocol !== b.protocol || !(u.host === b.host || u.hostname.endsWith(".discovercars.com"))) return fallback;
    u.searchParams.set("a_aid", process.env.DISCOVERCARS_AFFILIATE_ID?.trim() ?? "");
    return u.toString();
  } catch {
    return fallback;
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const carId = (location: string, pickup: string, dropoff: string) => `car_${createHash("sha256").update(`${location.toLowerCase()}|${pickup}|${dropoff}`).digest("hex").slice(0, 10)}`;

export function parseCarSearch(
  o: Record<string, unknown>,
  today: string,
): { location: string; pickup: string; dropoff: string; countryCode: string; city: string; airport: string } | string {
  const location = str(o.location, 80);
  const countryCode = str(o.country_code, 8).toUpperCase();
  const city = str(o.city, 60);
  const airport = str(o.airport_code, 8).toUpperCase();
  const pickup = str(o.pickup_date, 10);
  const dropoff = str(o.dropoff_date, 10);
  if (!location) return "give the pickup city or airport";
  if (!isDate(pickup) || !isDate(dropoff)) return "dates must be YYYY-MM-DD";
  if (pickup < today) return `${pickup} is in the past (today is ${today})`;
  if (dropoff < pickup) return "drop-off must be on or after pick-up";
  return { location, pickup, dropoff, countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : "", city, airport: /^[A-Z]{3}$/.test(airport) ? airport : "" };
}

const SEARCH_PROPS = {
  location: { type: "string", description: "Pickup city or airport as people would search it, e.g. 'Vancouver Airport (YVR)'" },
  city: { type: "string", description: "The city alone, in English, e.g. 'Vancouver'" },
  country_code: { type: "string", description: "2-letter country code, e.g. CA" },
  airport_code: { type: "string", description: "3-letter airport code when picking up at an airport, or empty" },
  pickup_date: { type: "string", description: "YYYY-MM-DD" },
  dropoff_date: { type: "string", description: "YYYY-MM-DD" },
} as const;

const LINK_TOOL: Anthropic.Beta.BetaTool = {
  name: "rental_car_link",
  description: "Show a rental car card for a pickup place and dates, with a button to compare and book cars on Discover Cars.",
  input_schema: {
    type: "object",
    properties: SEARCH_PROPS,
    required: ["location", "city", "country_code", "airport_code", "pickup_date", "dropoff_date"],
    additionalProperties: false,
  },
};

const BROWSER_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "rental_car_browse",
    description:
      "Open Discover Cars in the live browser the shopper is watching, for a pickup place and dates, so you can fill in its search form (with rental_car_act) and show them real cars and prices. Returns a screenshot (1280×800 px, a desktop browser).",
    input_schema: {
      type: "object",
      properties: {
        ...SEARCH_PROPS,
        pickup_time: { type: "string", description: "HH:MM (24h), e.g. an hour after the flight lands; empty to leave the site's default" },
        dropoff_time: { type: "string", description: "HH:MM (24h); empty to leave the site's default" },
      },
      required: ["location", "city", "country_code", "airport_code", "pickup_date", "dropoff_date"],
    },
  },
  {
    name: "rental_car_act",
    description:
      "Work Discover Cars' page in the live browser: actions run in order (up to 8), then one screenshot. Fastest first: smart actions find the field themselves by its label and report what they did: fill {field, value, choose (pick the matching suggestion)}, select {field, value} (dropdowns; times in any format like 10:30), date {field?, value YYYY-MM-DD} (opens the calendar and pages to the day; omit field when a calendar is already open), click_text {text} (a button or link by its words, e.g. 'Sort by price' or 'View deal'). Put several in one call. Only when one fails: tap x/y (pixels on the latest screenshot), type, key, scroll. Only Discover Cars pages open. Type driver details only exactly as rental_car_driver_details returned them after the shopper approved them, and never type or look for card details.",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["fill", "select", "date", "click_text", "tap", "type", "key", "scroll", "back", "wait"] },
              field: { type: "string", description: "For fill/select/date: the field as the page labels it, e.g. 'pick-up location', 'drop-off time'" },
              value: { type: "string", description: "For fill/select/date" },
              choose: { type: "boolean", description: "For fill: pick the matching suggestion after typing" },
              x: { type: "number" },
              y: { type: "number" },
              text: { type: "string", description: "For type: the text to type. For click_text: the button or link's words" },
              key: { type: "string", enum: ["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp"] },
              dy: { type: "number", description: "For scroll: pixels down (negative scrolls up)" },
              ms: { type: "number" },
            },
            required: ["type"],
          },
        },
      },
      required: ["actions"],
    },
  },
  {
    name: "rental_car_hand_over",
    description:
      "Hand the live browser to the shopper on Discover Cars for something only they can do: a robot check, a choice only they can make (which car), or payment (they enter their card and tap Book themselves; you never see that page). It opens full screen with your one-line message; your turn pauses until they tap Approve & next, then you get the page as it is now (after payment: only where it went, plus a screenshot once it has left the payment page).",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["captcha", "choice", "payment"] },
        message: { type: "string", description: 'One short line, e.g. "Pick the car you like, then tap Approve & next."' },
      },
      required: ["reason", "message"],
    },
  },
  {
    name: "rental_car_continue",
    description:
      "Finish: show the shopper a card with a \"Continue on Discover Cars\" button that opens the page from the live browser (the filled-in search, or the car they picked) in their own browser, where they enter their details, pay and book. Call it once the search is filled in and you've compared the cars.",
    input_schema: {
      type: "object",
      properties: {
        location: SEARCH_PROPS.location,
        pickup_date: SEARCH_PROPS.pickup_date,
        dropoff_date: SEARCH_PROPS.dropoff_date,
        pick: {
          type: "object",
          description: "Your recommendation: the most economical sensible car from the results, exactly as the page showed it.",
          properties: {
            car: { type: "string", description: "e.g. 'Economy · Kia Rio or similar'" },
            price: { type: "string", description: "The total for the rental as shown, e.g. '$123 total ($41/day)'" },
            supplier: { type: "string", description: "Rental company and its rating, e.g. 'Alamo · 8.4'" },
            why: { type: "string", description: "One short line: why it's the best value (fuel policy, mileage, free cancellation)" },
          },
          required: ["car", "price"],
        },
      },
      required: ["location", "pickup_date", "dropoff_date"],
    },
  },
  {
    name: "rental_car_driver_details",
    description:
      "Once the chosen car's driver form is open: shows the shopper the details you'll enter (their saved details, trip bookings, or what they told you), waits for Approve & next, then fills the form itself and returns a screenshot. Fix only fields it couldn't fill.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Driver's full name; empty to use their saved details (My details), else their trip bookings" },
        email: { type: "string", description: "Empty to use their saved details, else their trip bookings" },
        phone: { type: "string", description: "Empty to use their saved details, else their trip bookings" },
        flight_number: { type: "string", description: "Their arrival flight number, if the form asks, e.g. 'AC 1630'" },
      },
    },
  },
];

export const discoverCarsConnector: Connector = {
  id: "discovercars",
  label: "Rental cars (Discover Cars)",
  enabled: discoverCarsConfigured,
  prompt: () =>
    browserConfigured()
      ? `
Rental cars (Discover Cars):
- For a rental car, use the live browser so the shopper sees real cars: rental_car_browse with the pickup place, dates and times (pick up about an hour after the flight lands; drop off a few hours before the flight home, or at checkout time). It fills in Discover Cars' whole search and submits it by itself, and tells you what (if anything) it couldn't fill. Call it on its own (no other browser tool in the same reply) and wait for its result. Fix only that, with rental_car_act's smart actions (fill / select / date / click_text, several per call); tap by coordinates only as a last resort. Be quick: as few calls as possible.
- Be fast: a few calls, several actions each. On extras or insurance screens, click_text "Skip", "No, I'll take the risk" or "Continue" (no paid extras unless asked).
- When results show, sort them by price (lowest first) on the page (select "Sort by" "Price", or click_text the price sort) and recommend the most economical sensible car: the cheapest with a full-to-full fuel policy, unlimited (or enough) mileage and a supplier rated about 7/10 or better, free cancellation when the price is close. Read the total for the whole rental from the page.
- Finish with rental_car_continue with your pick. The card shows it with "Book it for me" and a link to continue on Discover Cars themselves.
- "Book it for me" (or they ask you to book it): open that car's deal in the live browser (View deal / Select), call rental_car_driver_details (it shows the details for approval, then fills the driver form itself); fix only what it couldn't fill. Leave paid extras unticked unless they asked. At the payment step call rental_car_hand_over with reason payment: they enter their card and tap Book themselves. Never type or look for card details, and never tap the final Book/Pay button yourself. Afterwards tell them the confirmation number if the page shows one (Discover Cars emails the voucher).
- If Discover Cars won't load or the form won't fill after a few tries, don't stall: use rental_car_link (a card that opens Discover Cars for that place) and say they can enter the dates there.
- After a flight or hotel is booked or chosen, offer a car for those dates at the destination airport, once.`
      : `
Rental cars:
- For rental cars, use rental_car_link with the pickup city or airport and the dates. The shopper sees a card with a "Find a car" button that opens Discover Cars, which compares cars from the rental companies there; they pick, pay and book on Discover Cars.
- You can't see car prices or availability, so never quote either or promise a car type. Say what to search for and tips (book early, check the fuel and mileage policy, what deposit to expect).
- After a flight or hotel is booked or chosen, offer a car for those dates at the destination airport, once.`,
  get tools() {
    return [LINK_TOOL, ...(browserConfigured() ? BROWSER_TOOLS : [])];
  },
  async run(tool, input, ctx) {
    if (tool === "rental_car_link") {
      const s = parseCarSearch(input, new Date().toISOString().slice(0, 10));
      if (typeof s === "string") return { content: `Can't make the link: ${s}.`, isError: true };
      const card: CarRentalCard = {
        kind: "car",
        id: `car_${randomBytes(5).toString("hex")}`,
        location: s.location,
        pickup: s.pickup,
        dropoff: s.dropoff,
        url: discoverCarsUrl({ countryCode: s.countryCode, city: s.city, airport: s.airport }),
      };
      ctx.show("", [card]);
      return { content: JSON.stringify({ ok: true, shown_as_card: true, note: "The button opens Discover Cars on the pickup location (or its search page); the shopper enters the dates there." }) };
    }
    if (!browserConfigured()) return { content: `Unknown tool ${tool}.`, isError: true };
    return browse(tool, input, ctx);
  },
};

/* ---------- Discover Cars in the live browser ---------- */

const liveCard = (session: string, handoff?: string): BrowserCard => ({ kind: "browser", id: `br_${session}`, session, site: SITE, ...(handoff ? { handoff } : {}), group: "Live browser" });

// The payment page each chat handed to the shopper: never screenshotted for the model while it's still showing.
const paymentPages = processSingleton("discovercars-payment-pages", () => new Map<string, string>());

function shot(p: PageState, facts: Record<string, unknown>, note?: string, chatId?: string): ToolResult {
  const paying = chatId ? paymentPages.get(chatId) : undefined;
  if (paying && p.url !== paying && chatId) paymentPages.delete(chatId);
  const hidden = !!paying && p.url === paying;
  const notes = [
    note,
    hidden ? "This is the payment page, which stays private (no screenshot). Ask the shopper whether they booked, and for anything you need from it." : "",
    p.needsShopper ? "The page shows a robot check: call rental_car_hand_over with reason captcha and a one-line message." : "",
  ].filter(Boolean);
  const text = JSON.stringify({ ...facts, page: { url: p.url, title: p.title }, ...(notes.length ? { important: notes.join(" ") } : {}) });
  if (!p.screenshot || hidden) return { content: text };
  return { content: [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.screenshot } }] };
}

const STOPPED = "The shopper didn't finish that step in time, so you stopped waiting. End your turn: tell them in one line that you'll carry on when they say so.";

async function browse(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult> {
  const signal = ctx.signal;
  const handOver = async (sessionId: string, kind: PendingKind, message: string): Promise<PageState | "stopped"> => {
    ctx.show("Live browser", [liveCard(sessionId, message)]);
    const w = await ctx.waitForShopper({ kind, message, browser: { sessionId, cardId: `br_${sessionId}` } });
    ctx.show("Live browser", [liveCard(sessionId)]);
    if (w.outcome !== "resumed") return "stopped";
    return (await inBrowser(ctx.chatId, (id) => browserApi.state(id, signal), signal)).result;
  };
  try {
    if (tool === "rental_car_browse") {
      const s = parseCarSearch(input, new Date().toISOString().slice(0, 10));
      if (typeof s === "string") return { content: `Can't search: ${s}.`, isError: true };
      // A trip with a hotel: the car comes after the hotel is booked (one thing in the browser at a time).
      const chat = await prisma.assistantChat.findUnique({ where: { id: ctx.chatId }, select: { uiJson: true } });
      if (chat && chatShown(chat.uiJson).hotels.size && !(await bookingsForChat(ctx.chatId)).hotels.length)
        return {
          content: JSON.stringify({
            waiting: true,
            note: "Not yet: the car comes after the hotel is booked. Don't open the browser now. Tell the shopper in one line to book the flight and hotel with their Book buttons, and that you'll find the cheapest car at the airport as soon as the hotel is booked. When the chat says the hotel is booked, call rental_car_browse again.",
          }),
        };
      const pickupTime = TIME.test(str(input.pickup_time, 5)) ? str(input.pickup_time, 5) : "";
      const dropoffTime = TIME.test(str(input.dropoff_time, 5)) ? str(input.dropoff_time, 5) : "";
      ctx.progress("Opening Discover Cars…");
      const url = discoverCarsUrl({ countryCode: s.countryCode, city: s.city, airport: s.airport });
      // If Discover Cars won't load in our browser (slow, or blocking it), don't struggle: show the link card.
      const fallback = async (why: string): Promise<ToolResult> => {
        const card: CarRentalCard = { kind: "car", id: carId(s.location, s.pickup, s.dropoff), location: s.location, pickup: s.pickup, dropoff: s.dropoff, url };
        ctx.show("", [card]);
        return {
          content: JSON.stringify({
            shown_as_card: "Find a car",
            why,
            tell_the_shopper: `Discover Cars didn't load in your browser just now, so tap Find a car: it opens Discover Cars in their own browser for ${s.location}, where they enter ${s.pickup} to ${s.dropoff}, pick the cheapest car with full-to-full fuel, and book. Don't try the live browser again for this car.`,
          }),
        };
      };
      let opened: { result: Awaited<ReturnType<typeof browserApi.act>>; session: { id: string } };
      try {
        opened = await inBrowser(ctx.chatId, (id) => browserApi.act(id, [{ type: "goto", url }, { type: "wait", ms: 600 }], signal), signal);
      } catch (e) {
        if (signal.aborted) throw e;
        return fallback(e instanceof Error ? e.message : "it didn't load");
      }
      let { result: p } = opened;
      const { session } = opened;
      if (!/discovercars/i.test(p.url) && !/^http:\/\/127\.0\.0\.1/.test(p.url)) return fallback("the page didn't open");
      ctx.show("Live browser", [liveCard(session.id)]);
      if (p.needsShopper) {
        const after = await handOver(session.id, "captcha", "Discover Cars wants to check you're not a robot. Get past it, then tap Approve & next.");
        if (after === "stopped") return { content: STOPPED };
        p = after;
      }
      const search = { location: s.location, pickup: `${s.pickup}${pickupTime ? ` ${pickupTime}` : ""}`, dropoff: `${s.dropoff}${dropoffTime ? ` ${dropoffTime}` : ""}` };
      // Fill the whole search right here (the page finds each field itself): no screenshot round trips.
      ctx.progress("Filling in the search…");
      // Steps in a row skip the screenshot; only the last call (after Search) takes one.
      const run = async (actions: unknown[], noShot = true) => (await inBrowser(ctx.chatId, (id) => browserApi.act(id, actions, signal, { noShot }), signal)).result;
      const steps: Array<{ type: string; field?: string; text?: string; ok: boolean; did?: string; why?: string; fields?: string[] }> = [];
      const where = s.airport ? `${s.city || s.location} ${s.airport}` : s.location;
      // A cookie banner may cover the form: accept it if there is one (no harm when there isn't).
      const first = await run([
        { type: "click_text", text: "Accept all" },
        { type: "fill", field: "pick-up location", value: where, choose: true },
        { type: "date", field: "pick-up date", value: s.pickup },
      ]);
      steps.push(...(first.results ?? []).slice(1));
      // Range calendars stay open for the drop-off day: try the field, then the open calendar.
      let drop = (await run([{ type: "date", field: "drop-off date", value: s.dropoff }])).results?.[0];
      if (drop && !drop.ok) drop = (await run([{ type: "date", value: s.dropoff }])).results?.[0] ?? drop;
      if (drop) steps.push({ ...drop, field: "drop-off date" });
      p = await run(
        [
          ...(pickupTime ? [{ type: "select", field: "pick-up time", value: pickupTime }] : []),
          ...(dropoffTime ? [{ type: "select", field: "drop-off time", value: dropoffTime }] : []),
          { type: "click_text", text: "Search" },
          { type: "wait", ms: 1200 },
        ],
        false,
      );
      steps.push(...(p.results ?? []));
      const failed = steps.filter((x) => !x.ok);
      const fieldsOnPage = failed.find((x) => x.fields?.length)?.fields;
      return shot(
        p,
        { site: SITE, search, filled: steps.map((x) => `${x.ok ? "✓" : "✗"} ${x.field ?? x.text ?? x.type}: ${x.ok ? x.did : x.why}`), ...(fieldsOnPage ? { fields_on_page: fieldsOnPage } : {}) },
        failed.length
          ? failed.some((x) => /date|time/i.test(String(x.field ?? "")))
            ? `The dates or times didn't fill (${failed.map((x) => x.field ?? x.text).join(", ")}). Don't tap through the calendar yourself: call rental_car_hand_over once with reason choice and the message "Set ${search.pickup} to ${search.dropoff} (with the times), tap Search, then Approve & next." Then carry on from the results.`
            : `Most of the search was filled in automatically. Fix only what failed (${failed.map((x) => x.field ?? x.text).join(", ")}) with rental_car_act: smart actions first (fill / select / date / click_text, naming the field as fields_on_page labels it), taps only as a last resort; then click_text "Search".`
          : "The search is filled in and submitted. If the screenshot shows results, sort by price and pick; if it still shows the form, check it and click_text the search button.",
      );
    }
    if (tool === "rental_car_act") {
      const allowed = new Set(["fill", "select", "date", "click_text", "tap", "type", "key", "scroll", "back", "wait"]);
      const actions = (Array.isArray(input.actions) ? input.actions : []).slice(0, 8).filter((a) => allowed.has(String((a as { type?: unknown })?.type)));
      if (!actions.length) return { content: "No actions given.", isError: true };
      ctx.progress("Filling in Discover Cars…");
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.act(id, actions, signal), signal);
      ctx.show("Live browser", [liveCard(session.id)]);
      return shot(p, { done: actions.length, ...(p.results?.length ? { results: p.results } : {}) }, undefined, ctx.chatId);
    }
    if (tool === "rental_car_hand_over") {
      const sessionId = await chatBrowserId(ctx.chatId);
      if (!sessionId) return { content: "The browser has closed. Open Discover Cars again with rental_car_browse.", isError: true };
      if (input.reason === "payment") {
        const now = await browserApi.state(sessionId, signal);
        paymentPages.set(ctx.chatId, now.url);
        const after = await handOver(sessionId, "checkout", str(input.message, 160) || "Enter your card details and tap Book. Neon can't see this page. Then tap Approve & next.");
        if (after === "stopped") return { content: STOPPED };
        return shot(
          after,
          { handedBack: true, afterPayment: true },
          "The shopper handed back after the payment step. If the page shows a booking confirmation, tell them the confirmation number and that Discover Cars emails the voucher; otherwise ask whether they booked.",
          ctx.chatId,
        );
      }
      const kind = input.reason === "captcha" ? "captcha" : "choice";
      const after = await handOver(sessionId, kind, str(input.message, 160) || "Your turn: tap Approve & next when you're done.");
      if (after === "stopped") return { content: STOPPED };
      return shot(after, { handedBack: true }, "The shopper handed back; this is the page now. Carry on.", ctx.chatId);
    }
    if (tool === "rental_car_driver_details") {
      const b = await bookingsForChat(ctx.chatId);
      const hotel = b.hotels[0];
      const flight = b.flights[0];
      // What they told you, then their saved details (My details), then their trip bookings.
      const chat = await prisma.assistantChat.findUnique({ where: { id: ctx.chatId }, select: { customerId: true, visitorId: true } });
      const saved = chat ? await getProfile({ customerId: chat.customerId, visitorId: chat.visitorId }) : null;
      const savedName = [saved?.givenName, saved?.familyName].filter(Boolean).join(" ");
      const name = str(input.name, 80) || savedName || hotel?.guest || flight?.passengers[0] || "";
      const email = str(input.email, 120) || saved?.email || hotel?.email || flight?.email || "";
      const phone = str(input.phone, 40) || saved?.phone || hotel?.phone || flight?.phone || "";
      const flightNumber = str(input.flight_number, 20) || flight?.slices[0]?.flights[0] || "";
      if (!name || !email) return { content: "No driver name or email yet: ask the shopper for the driver's name, email and phone, then call this again with them.", isError: true };
      const address = saved?.addressLine1 ? [saved.addressLine1, saved.addressLine2, saved.city, saved.region, saved.postalCode, saved.country].filter(Boolean).join(", ") : "";
      const details = { name, email, ...(phone ? { phone } : {}), ...(flightNumber ? { flight_number: flightNumber } : {}), ...(address ? { address_if_asked: address } : {}), ...(saved?.bornOn ? { date_of_birth_if_asked: saved.bornOn } : {}) };
      const w = await ctx.waitForShopper({
        kind: "choice",
        message: `Book with these driver details? ${name} · ${email}${phone ? ` · ${phone}` : ""}${flightNumber ? ` · flight ${flightNumber}` : ""}${address ? ` · ${address}` : ""}${saved?.bornOn ? ` · born ${saved.bornOn}` : ""}. Approve & next and Neon fills them in on Discover Cars.`,
        browser: null,
      });
      if (w.outcome !== "resumed") return { content: "The shopper didn't approve the driver details, so don't type them. Ask what to change." };
      // Approved: fill the driver form right away (the page finds each field), one screenshot at the end.
      ctx.progress("Filling in the driver details…");
      const [first, ...rest] = name.split(/\s+/);
      const last = rest.join(" ");
      const fill = async (actions: unknown[]) => (await inBrowser(ctx.chatId, (id) => browserApi.act(id, actions, signal, { noShot: true }), signal)).result.results ?? [];
      const done: Array<{ field?: string; ok: boolean; did?: string; why?: string }> = [];
      // Separate first and last name fields, else one full-name field.
      const firstR = (await fill([{ type: "fill", field: "first name", value: first }]))[0];
      if (firstR?.ok && last) done.push(firstR, ...(await fill([{ type: "fill", field: "last name", value: last }])));
      else done.push(...(await fill([{ type: "fill", field: "full name", value: name }])).map((r) => ({ ...r, field: "name" })));
      done.push(...(await fill([{ type: "fill", field: "email", value: email }])));
      if (phone) done.push(...(await fill([{ type: "fill", field: "phone", value: phone }])));
      if (flightNumber) done.push(...(await fill([{ type: "fill", field: "flight number", value: flightNumber }])));
      const sid = await chatBrowserId(ctx.chatId);
      const now = sid ? await browserApi.state(sid, signal).catch(() => null) : null;
      const report = { approved: true, details, filled: done.map((x) => `${x.ok ? "✓" : "✗"} ${x.field}: ${x.ok ? x.did : x.why}`) };
      const next = "Already filled where marked ✓; fix only ✗ fields with rental_car_act (exactly these details). Leave paid extras unticked unless the shopper asked. Then go to the payment step (click_text the continue button) and call rental_car_hand_over with reason payment.";
      return now ? shot(now, report, next, ctx.chatId) : { content: JSON.stringify({ ...report, next }) };
    }
    if (tool === "rental_car_continue") {
      const location = str(input.location, 80);
      const pickup = str(input.pickup_date, 10);
      const dropoff = str(input.dropoff_date, 10);
      if (!location || !isDate(pickup) || !isDate(dropoff) || dropoff < pickup) return { content: "Give the place and the pick-up and drop-off dates (YYYY-MM-DD).", isError: true };
      const sessionId = await chatBrowserId(ctx.chatId);
      // A quick look only: if the page is stuck, fall back to Discover Cars' own page for the link.
      const page = sessionId ? await Promise.race([browserApi.state(sessionId, signal).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 6000))]) : null;
      const url = continueUrl(page?.url, discoverCarsUrl());
      const pk = input.pick && typeof input.pick === "object" ? (input.pick as Record<string, unknown>) : null;
      const pick = pk && str(pk.car, 80) && str(pk.price, 60) ? { car: str(pk.car, 80), price: str(pk.price, 60), ...(str(pk.supplier, 60) ? { supplier: str(pk.supplier, 60) } : {}), ...(str(pk.why, 140) ? { why: str(pk.why, 140) } : {}) } : undefined;
      const card: CarRentalCard = { kind: "car", id: carId(location, pickup, dropoff), location, pickup, dropoff, url, filled: url !== discoverCarsUrl(), ...(pick ? { pick } : {}) };
      ctx.show("", [card]);
      return {
        content: JSON.stringify({
          shown_as_card: "Continue on Discover Cars",
          opens: card.filled ? "the page from the live browser" : "Discover Cars' home page (the live page wasn't available)",
          tell_the_shopper: pick
            ? `Recommend the ${pick.car} (${pick.price}) in one or two lines and why. They can tap "Book it for me" (you open it, fill in the driver details they approve, and hand them the payment step) or continue on Discover Cars themselves.`
            : "Tap Continue on Discover Cars: it opens this search in their own browser, where they pick the car, enter their details, pay and book. Their confirmation comes from Discover Cars. If the page asks for the search again, the place and dates are on the card.",
        }),
      };
    }
    return { content: `Unknown tool ${tool}.`, isError: true };
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof BrowserError) {
      if (isBusy(e)) return { content: "The browser is still finishing an earlier step. Try the same tool once more.", isError: true };
      return { content: `The browser couldn't do that (${e.message}). Try again, or fall back to rental_car_link.`, isError: true };
    }
    throw e;
  }
}
