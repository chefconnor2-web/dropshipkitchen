// Rental cars through Discover Cars, as an affiliate: Neon shows a card with where and when, and a button to
// Discover Cars (our affiliate link), where the shopper compares cars from rental companies and books. They pay
// Discover Cars directly; we earn a commission on completed rentals. No payment, stock or risk on our side.
//
// With the live browser (lib/browser.ts) on, Neon can also open Discover Cars in it and fill in the search
// (place, dates, times) while the shopper watches, compare the cars, then hand over one "Continue on Discover
// Cars" link to that page. The shopper books and pays on Discover Cars in their own browser: Neon never types
// their details or payment, and never books.
//
// DISCOVERCARS_AFFILIATE_ID  the a_aid from the Discover Cars affiliate dashboard
// DISCOVERCARS_BASE_URL      tests only (a local stand-in for the site)

import type Anthropic from "@anthropic-ai/sdk";
import { createHash, randomBytes } from "node:crypto";
import type { BrowserCard, CarRentalCard } from "@/lib/flights-shared";
import { BrowserError, browserApi, browserConfigured, chatBrowserId, inBrowser, isBusy, type PageState } from "@/lib/browser";
import type { Connector, ConnectorContext, ToolResult } from "./types";

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
      "Work Discover Cars' page in the live browser: actions run in order, then you get a screenshot to check the result. tap x/y are pixels on the latest screenshot (a click). Use it to fill the search form (tap the pick-up field, type the place, tap the right suggestion; set the dates and times in the calendar; tap Search), then read and sort the results. Only Discover Cars pages open. Never type the shopper's name, email, phone, address, licence or card details, and never go past choosing a car.",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["tap", "type", "key", "scroll", "back", "wait"] },
              x: { type: "number" },
              y: { type: "number" },
              text: { type: "string", description: "For type: a place name or a date/time as the field expects" },
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
      "Hand the live browser to the shopper on Discover Cars for something only they can do: a robot check, or a choice only they can make (which car). It opens full screen with your one-line message; your turn pauses until they tap Approve & next, then you get the page as it is now.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", enum: ["captcha", "choice"] },
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
      },
      required: ["location", "pickup_date", "dropoff_date"],
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
- For a rental car, use the live browser so the shopper sees real cars: rental_car_browse with the pickup place, dates and times (pick up about an hour after the flight lands; drop off a few hours before the flight home, or at checkout time). Then fill Discover Cars' search form with rental_car_act, checking each screenshot: tap the pick-up location field, type the place, tap the matching suggestion (the airport when picking up at one); open the dates and pick the pick-up and drop-off days (and times, if shown); tap Search. Keep each call to a few actions and look at the result before the next.
- When results show, compare a few good options for them in a few words (car type, price as shown, supplier rating, fuel and mileage policy). If they want to pick on the page, use rental_car_hand_over with reason choice.
- Finish with rental_car_continue: they continue on Discover Cars in their own browser, where they enter their details, pay and book. Never type their name, email, phone, address, licence or card details, and never try to book.
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

function shot(p: PageState, facts: Record<string, unknown>, note?: string): ToolResult {
  const notes = [note, p.needsShopper ? "The page shows a robot check: call rental_car_hand_over with reason captcha and a one-line message." : ""].filter(Boolean);
  const text = JSON.stringify({ ...facts, page: { url: p.url, title: p.title }, ...(notes.length ? { important: notes.join(" ") } : {}) });
  if (!p.screenshot) return { content: text };
  return { content: [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.screenshot } }] };
}

const STOPPED = "The shopper didn't finish that step in time, so you stopped waiting. End your turn: tell them in one line that you'll carry on when they say so.";

async function browse(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult> {
  const signal = ctx.signal;
  const handOver = async (sessionId: string, kind: "captcha" | "choice", message: string): Promise<PageState | "stopped"> => {
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
      const pickupTime = TIME.test(str(input.pickup_time, 5)) ? str(input.pickup_time, 5) : "";
      const dropoffTime = TIME.test(str(input.dropoff_time, 5)) ? str(input.dropoff_time, 5) : "";
      ctx.progress("Opening Discover Cars…");
      const url = discoverCarsUrl({ countryCode: s.countryCode, city: s.city, airport: s.airport });
      let { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.act(id, [{ type: "goto", url }, { type: "wait", ms: 1500 }], signal), signal);
      ctx.show("Live browser", [liveCard(session.id)]);
      if (p.needsShopper) {
        const after = await handOver(session.id, "captcha", "Discover Cars wants to check you're not a robot. Get past it, then tap Approve & next.");
        if (after === "stopped") return { content: STOPPED };
        p = after;
      }
      const search = { location: s.location, pickup: `${s.pickup}${pickupTime ? ` ${pickupTime}` : ""}`, dropoff: `${s.dropoff}${dropoffTime ? ` ${dropoffTime}` : ""}` };
      return shot(
        p,
        { site: SITE, search },
        "Discover Cars is open in the live browser. Fill its search form with rental_car_act (a few actions per call, checking each screenshot): the pick-up location, then the dates and times, then Search. Dismiss a cookie banner first if one covers the form.",
      );
    }
    if (tool === "rental_car_act") {
      const allowed = new Set(["tap", "type", "key", "scroll", "back", "wait"]);
      const actions = (Array.isArray(input.actions) ? input.actions : []).slice(0, 8).filter((a) => allowed.has(String((a as { type?: unknown })?.type)));
      if (!actions.length) return { content: "No actions given.", isError: true };
      ctx.progress("Filling in Discover Cars…");
      const { result: p, session } = await inBrowser(ctx.chatId, (id) => browserApi.act(id, actions, signal), signal);
      ctx.show("Live browser", [liveCard(session.id)]);
      return shot(p, { done: actions.length });
    }
    if (tool === "rental_car_hand_over") {
      const sessionId = await chatBrowserId(ctx.chatId);
      if (!sessionId) return { content: "The browser has closed. Open Discover Cars again with rental_car_browse.", isError: true };
      const kind = input.reason === "captcha" ? "captcha" : "choice";
      const after = await handOver(sessionId, kind, str(input.message, 160) || "Your turn: tap Approve & next when you're done.");
      if (after === "stopped") return { content: STOPPED };
      return shot(after, { handedBack: true }, "The shopper handed back; this is the page now. Carry on (finish with rental_car_continue).");
    }
    if (tool === "rental_car_continue") {
      const location = str(input.location, 80);
      const pickup = str(input.pickup_date, 10);
      const dropoff = str(input.dropoff_date, 10);
      if (!location || !isDate(pickup) || !isDate(dropoff) || dropoff < pickup) return { content: "Give the place and the pick-up and drop-off dates (YYYY-MM-DD).", isError: true };
      const sessionId = await chatBrowserId(ctx.chatId);
      const page = sessionId ? await browserApi.state(sessionId, signal).catch(() => null) : null;
      const url = continueUrl(page?.url, discoverCarsUrl());
      const card: CarRentalCard = { kind: "car", id: carId(location, pickup, dropoff), location, pickup, dropoff, url, filled: url !== discoverCarsUrl() };
      ctx.show("", [card]);
      return {
        content: JSON.stringify({
          shown_as_card: "Continue on Discover Cars",
          opens: card.filled ? "the page from the live browser" : "Discover Cars' home page (the live page wasn't available)",
          tell_the_shopper: "Tap Continue on Discover Cars: it opens this search in their own browser, where they pick the car, enter their details, pay and book. Their confirmation comes from Discover Cars. If the page asks for the search again, the place and dates are on the card.",
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
