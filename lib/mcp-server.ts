// The Chit MCP server: Chit's travel tools for other assistants (Claude custom connectors, ChatGPT apps). It runs
// Neon's own connectors (lib/connectors/*), not a second copy, for one signed-in customer. Every search lands in
// a Chit chat of theirs (a "trip"), so the cards, bookings, itinerary and receipts show in Chit too, and booking
// links file the booking under it. Tools never take payment: they return booking links, and the customer pays
// on Chit's checkout (or Discover Cars') in their own browser.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { duffelConnector } from "@/lib/connectors/duffel";
import { liteapiConnector } from "@/lib/connectors/liteapi";
import { companyConnector } from "@/lib/connectors/company";
import { discoverCarsUrl } from "@/lib/connectors/discovercars";
import type { ConnectorContext, ToolResult } from "@/lib/connectors/types";
import type { CarRentalCard, ConnectorItem } from "@/lib/flights-shared";
import { CATEGORIES, logExpense, membershipOf } from "@/lib/company";
import { tripsFor } from "@/lib/trips";

/** Tool calls per customer: per minute and per hour. */
const PER_MINUTE = 20;
const PER_HOUR = 300;

export const INSTRUCTIONS = `Chit searches live flights (Duffel), hotels (LiteAPI) and rental cars (Discover Cars) for the signed-in Chit customer, and shows their trips, receipts and company travel policy.
- Payment always happens on Chit's own checkout page in the customer's browser: give them the book_url of the option they want. Never ask for card details.
- Every search returns a trip_id. Pass it to later searches for the same trip (flights, then hotel, then car) so they stay together in the customer's Chit trips.
- Prices include Chit's fee. Only quote prices and options the tools returned.
- For work trips call company_policy first and stay within it, then call set_work_trip.`;

interface Who {
  customerId: string;
  clientId: string;
  clientName: string;
}

const txt = (o: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o) }], ...(isError ? { isError: true } : {}) });

/** The customer's chat for this trip: theirs when trip_id is given, else a new one. */
async function tripChat(who: Who, tripId: string | undefined, title: string): Promise<string> {
  if (tripId) {
    const c = await prisma.assistantChat.findUnique({ where: { id: tripId }, select: { id: true, customerId: true } });
    if (c && c.customerId === who.customerId) return c.id;
  }
  const c = await prisma.assistantChat.create({ data: { customerId: who.customerId, title: `${title} · via ${who.clientName}`.slice(0, 80), userTurns: 1 } });
  return c.id;
}

/** Adds what was asked and the cards it found to the trip's chat, so Neon (and the customer) see it in Chit. */
async function record(chatId: string, asked: string, said: string, items: ConnectorItem[]) {
  const c = await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { uiJson: true, messagesJson: true } });
  if (!c) return;
  const at = new Date().toISOString();
  const ui = JSON.parse(c.uiJson || "[]") as unknown[];
  const messages = JSON.parse(c.messagesJson || "[]") as unknown[];
  ui.push({ role: "user", text: asked, at }, { role: "assistant", text: said, cards: [], added: [], items, at });
  messages.push({ role: "user", content: asked }, { role: "assistant", content: said });
  await prisma.assistantChat.update({ where: { id: chatId }, data: { uiJson: JSON.stringify(ui), messagesJson: JSON.stringify(messages) } });
}

/** Runs one of Neon's connector tools in this trip's chat, collecting the cards it shows. */
async function runConnector(run: (tool: string, input: Record<string, unknown>, ctx: ConnectorContext) => Promise<ToolResult>, tool: string, input: Record<string, unknown>, chatId: string) {
  const shown = new Map<string, ConnectorItem>();
  const ctx: ConnectorContext = {
    chatId,
    progress: () => {},
    show: (_g, items) => items.forEach((i) => shown.set(i.id, i)),
    signal: AbortSignal.timeout(90_000),
    waitForShopper: async () => ({ outcome: "cancelled", stepId: "" }),
  };
  const r = await run(tool, input, ctx);
  return { result: r, items: [...shown.values()], text: typeof r.content === "string" ? r.content : r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n") };
}

const link = (path: string, chatId: string) => `${config.siteUrl}${path}?chat=${encodeURIComponent(chatId)}`;

async function rateLimited(customerId: string): Promise<boolean> {
  const [minute, hour] = await Promise.all([
    prisma.mcpCall.count({ where: { customerId, createdAt: { gt: new Date(Date.now() - 60_000) } } }),
    prisma.mcpCall.count({ where: { customerId, createdAt: { gt: new Date(Date.now() - 3600_000) } } }),
  ]);
  return minute >= PER_MINUTE || hour >= PER_HOUR;
}

type Out = ReturnType<typeof txt>;

/** Wraps a tool: rate limit, audit row, and errors as tool errors (never a thrown protocol error). */
function guarded<A>(who: Who, name: string, fn: (a: A) => Promise<Out>) {
  return async (a: A): Promise<Out> => {
    if (await rateLimited(who.customerId)) return txt("Too many requests for this account right now. Wait a minute and try again.", true);
    const t0 = Date.now();
    let out: Out;
    try {
      out = await fn(a);
    } catch (e) {
      console.error(`[mcp] ${name} failed:`, e instanceof Error ? e.message : e);
      out = txt(`${name} failed: ${e instanceof Error ? e.message : "an error"}. Try again.`, true);
    }
    await prisma.mcpCall.create({ data: { customerId: who.customerId, clientId: who.clientId, tool: name, ok: !("isError" in out), ms: Date.now() - t0 } }).catch(() => {});
    return out;
  };
}

const tripIdField = z.string().max(40).optional().describe("trip_id from an earlier search for the same trip; leave out to start a new trip");
const isDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** One MCP server per request (stateless), acting for this customer. */
export function chitMcpServer(who: Who): McpServer {
  const server = new McpServer({ name: "chit", title: `${config.storeName} travel`, version: "1.0.0", websiteUrl: config.siteUrl }, { instructions: INSTRUCTIONS });
  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  if (duffelConnector.enabled()) {
    server.registerTool(
      "find_places",
      { title: "Find airports", description: "Look up airports and cities by name. Returns IATA codes; city codes (YTO, LON, NYC) cover all of a city's airports.", inputSchema: { query: z.string().min(2).max(60) }, annotations: ro },
      guarded(who, "find_places", async ({ query }) => {
        const { result, text } = await runConnector(duffelConnector.run, "find_places", { query }, "mcp");
        return txt(text, !!result.isError);
      }),
    );

    server.registerTool(
      "search_flights",
      {
        title: "Search flights",
        description:
          "Search live airline fares, up to 6 searches at once (exact dates, nearby days, nonstop…). Returns up to 3 picks per search with price (fee included), times, stops, bags, fare types (Basic/Standard/Flex with change and refund rules) and a book_url where the customer enters passengers and pays.",
        inputSchema: {
          searches: z
            .array(
              z.object({
                label: z.string().max(30).describe("Short label, e.g. 'Exact dates', 'Nonstop'"),
                slices: z.array(z.object({ origin: z.string().describe("3-letter IATA airport or city code"), destination: z.string(), date: isDate })).min(1).max(4).describe("One-way = 1, return = 2, multi-city up to 4"),
                adults: z.number().int().min(1).max(9).default(1),
                child_ages: z.array(z.number().int().min(0).max(17)).max(8).default([]),
                cabin: z.enum(["economy", "premium_economy", "business", "first"]).default("economy"),
                max_stops: z.number().int().min(-1).max(2).default(-1).describe("0 nonstop only; -1 any"),
                depart_after: z.string().max(5).default("").describe("HH:MM or empty"),
                depart_before: z.string().max(5).default("").describe("HH:MM or empty"),
                checked_bag: z.boolean().default(false),
                fare: z.enum(["any", "changeable", "refundable"]).default("any"),
              }),
            )
            .min(1)
            .max(6),
          trip_id: tripIdField,
        },
        annotations: ro,
      },
      guarded(who, "search_flights", async ({ searches, trip_id }) => {
        const first = searches[0].slices;
        const title = `${first[0].origin} → ${first[0].destination}, ${first[0].date}`;
        const { result, items, text } = await runConnector(duffelConnector.run, "find_flights", { searches }, "mcp");
        if (result.isError) return txt(text, true);
        if (!items.length) return txt({ results: JSON.parse(text), note: "No flights matched. Try other dates, airports or fewer filters." });
        const chatId = await tripChat(who, trip_id, title);
        const groups = JSON.parse(text) as Array<{ picks?: Array<Record<string, unknown>> }>;
        for (const g of groups) for (const p of g.picks ?? []) p.book_url = link(`/flights/book/${encodeURIComponent(String(p.offer_id))}`, chatId);
        await record(chatId, `Find flights: ${title}`, `I found ${items.length} flight option${items.length === 1 ? "" : "s"} for you in ${who.clientName}. Tap Book on the one you want.`, items);
        return txt({ trip_id: chatId, results: groups, trip_url: `${config.siteUrl}/c/${chatId}` });
      }),
    );

    server.registerTool(
      "get_flight",
      { title: "Check a flight", description: "Re-check one flight offer now: current price, refund and change rules, extra bag prices, and its book_url.", inputSchema: { offer_id: z.string().max(80), trip_id: tripIdField }, annotations: ro },
      guarded(who, "get_flight", async ({ offer_id, trip_id }) => {
        const { result, text } = await runConnector(duffelConnector.run, "get_flight", { offer_id }, trip_id ?? "mcp");
        if (result.isError) return txt(text, true);
        const chatId = await tripChat(who, trip_id, "Flight");
        return txt({ ...JSON.parse(text), book_url: link(`/flights/book/${encodeURIComponent(offer_id)}`, chatId), trip_id: chatId });
      }),
    );
  }

  if (liteapiConnector.enabled()) {
    server.registerTool(
      "search_hotels",
      {
        title: "Search hotels",
        description: "Search live hotel rates in a city for the dates. Returns up to 6 picks with the total for the stay (fee and up-front taxes included), per-night price, room, meals, refundability and a book_url where the customer pays.",
        inputSchema: {
          city: z.string().max(60),
          country_code: z.string().length(2).describe("2-letter ISO country code"),
          checkin: isDate,
          checkout: isDate,
          adults: z.number().int().min(1).max(8).default(1),
          child_ages: z.array(z.number().int().min(0).max(17)).max(6).default([]),
          max_price_per_night: z.number().min(0).default(0).describe("0 for any"),
          min_stars: z.number().int().min(0).max(5).default(0),
          trip_id: tripIdField,
        },
        annotations: ro,
      },
      guarded(who, "search_hotels", async ({ trip_id, ...s }) => {
        const { result, items, text } = await runConnector(liteapiConnector.run, "find_hotels", s, "mcp");
        if (result.isError) return txt(text, true);
        if (!items.length) return txt({ ...JSON.parse(text), note: "No hotels matched. Try a higher budget, fewer stars or other dates." });
        const chatId = await tripChat(who, trip_id, `Hotels in ${s.city}, ${s.checkin}`);
        const out = JSON.parse(text) as { picks?: Array<Record<string, unknown>> };
        for (const p of out.picks ?? []) p.book_url = link(`/hotels/book/${encodeURIComponent(String(p.offer_id))}`, chatId);
        await record(chatId, `Find a hotel in ${s.city}, ${s.checkin} to ${s.checkout}`, `I found ${items.length} hotel${items.length === 1 ? "" : "s"} for you in ${who.clientName}. Tap Book on the one you want.`, items);
        return txt({ trip_id: chatId, ...out, trip_url: `${config.siteUrl}/c/${chatId}` });
      }),
    );
  }

  server.registerTool(
    "find_rental_car",
    {
      title: "Find a rental car",
      description:
        "A Discover Cars link for renting a car at a place and dates (it compares every rental company). The customer picks the car and pays on Discover Cars in their browser. The car is added to their Chit trip.",
      inputSchema: {
        location: z.string().max(80).describe("Where they pick up, e.g. 'Miami Airport (MIA)'"),
        city: z.string().max(60),
        country_code: z.string().length(2),
        airport: z.string().max(3).optional().describe("3-letter airport code, if picking up at an airport"),
        pickup: isDate,
        dropoff: isDate,
        trip_id: tripIdField,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guarded(who, "find_rental_car", async ({ location, city, country_code, airport, pickup, dropoff, trip_id }) => {
      if (dropoff < pickup) return txt("The drop-off date must be on or after the pick-up date.", true);
      const url = discoverCarsUrl({ countryCode: country_code, city, airport });
      const chatId = await tripChat(who, trip_id, `Car in ${city}, ${pickup}`);
      const card: CarRentalCard = { kind: "car", id: `car_${chatId}_${pickup}`, location, pickup, dropoff, url, group: "Rental car" };
      await record(chatId, `Find a rental car at ${location}, ${pickup} to ${dropoff}`, "Here's Discover Cars for your dates: pick the car and pay there.", [card]);
      return txt({
        trip_id: chatId,
        url,
        how: `Open the link, search ${location} from ${pickup} to ${dropoff}, and book the car there. Drivers renting outside their country of residence (e.g. a Canadian resident in the US) should set their country of residence in the search and pick a company that accepts it.`,
      });
    }),
  );

  server.registerTool(
    "my_trips",
    {
      title: "My trips",
      description: "The customer's Chit trips: each trip's itinerary in time order (flights, hotel check-in/out, rental cars) and its receipts (booking numbers, confirmation codes, amounts paid and refunded, status), with links to each booking.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(who, "my_trips", async () => {
      const trips = await tripsFor({ customerId: who.customerId, where: { customerId: who.customerId } });
      if (!trips.length) return txt({ trips: [], note: "No trips yet: nothing booked and paid for." });
      const abs = (h: string | null) => (h && h.startsWith("/") ? `${config.siteUrl}${h}` : h);
      return txt({ trips: trips.map((t) => ({ trip_id: t.chatId, ...t, receipts: t.receipts.map((r) => ({ ...r, href: abs(r.href) })) })) });
    }),
  );

  server.registerTool(
    "company_policy",
    { title: "Company travel policy", description: "The customer's company and its travel policy (plain English, written by their admin), if they belong to one. Call it before searching for a work trip.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } },
    guarded(who, "company_policy", async () => {
      const me = await membershipOf(who.customerId);
      if (!me) return txt({ in_company: false, note: "They're not in a company. Book normally; they can create one on Chit's Company page." });
      return txt({ in_company: true, company: me.company.name, role: me.role, currency: me.company.currency, policy: me.company.policy || "No written policy yet: use good judgement (economy, mid-range hotels)." });
    }),
  );

  server.registerTool(
    "set_work_trip",
    { title: "Mark a work trip", description: "Mark a trip as work (its bookings go to the company's expenses) or personal.", inputSchema: { trip_id: z.string().max(40), work: z.boolean() }, annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false } },
    guarded(who, "set_work_trip", async ({ trip_id, work }) => {
      const c = await prisma.assistantChat.findUnique({ where: { id: trip_id }, select: { customerId: true } });
      if (c?.customerId !== who.customerId) return txt("That trip_id isn't one of this customer's trips.", true);
      const { result, text } = await runConnector(companyConnector.run, "set_work_trip", { work }, trip_id);
      return txt(text, !!result.isError);
    }),
  );

  server.registerTool(
    "log_expense",
    {
      title: "Log an expense",
      description: "Log one work expense from a receipt (photo, PDF, email). Copy exactly what the receipt shows. Don't log things booked through Chit: they're added automatically.",
      inputSchema: {
        merchant: z.string().max(120),
        category: z.enum(CATEGORIES),
        amount: z.number().positive().describe("Total paid, tip included"),
        currency: z.string().length(3),
        tax: z.number().min(0).default(0),
        date: isDate,
        note: z.string().max(300).default(""),
        trip_id: tripIdField,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    guarded(who, "log_expense", async ({ trip_id, date, ...e }) => {
      const c = trip_id ? await prisma.assistantChat.findUnique({ where: { id: trip_id }, select: { customerId: true } }) : null;
      const chatId = c?.customerId === who.customerId ? trip_id! : null;
      const r = await logExpense(who.customerId, chatId, { ...e, tax: e.tax || null, spentOn: date });
      if (r.error) return txt(r.error, true);
      return txt({ logged: true, company: r.company ?? "none (kept in their own expenses)", expenses_page: `${config.siteUrl}/company` });
    }),
  );

  return server;
}
