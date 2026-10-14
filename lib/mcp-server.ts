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
import type { ConnectorContext, ToolResult } from "@/lib/connectors/types";
import type { ConnectorItem } from "@/lib/flights-shared";
import { CATEGORIES, logExpense, membershipOf } from "@/lib/company";
import { tripsFor } from "@/lib/trips";
import { browserCard, viewCards, type ViewCard } from "@/lib/mcp-cards";
import { randomBytes } from "node:crypto";
import { acting } from "@/lib/acting";
import { assistantConfigured, catalogTool } from "@/lib/assistant";
import { getCartId, getOrCreateCartId, loadCart } from "@/lib/cart";
import { searchCatalog } from "@/lib/catalog-search";
import { acceptRun, getRun, resumeRun } from "@/lib/runs";
import { isActive } from "@/lib/run-shared";
import { aiAllowance, limitMessage } from "@/lib/membership";
import { priceOrder } from "@/lib/volume";
import { formatMoney } from "@/lib/money";
import { VIEW_URI, viewHtml } from "@/lib/mcp-view";
import { guarded, txt, UI, withCards, type Out, type Who } from "@/lib/mcp-kit";
import { registerMoreTools } from "@/lib/mcp-tools-more";
import { browserConfigured, liveOrigin, mintLiveUrl } from "@/lib/browser";
import { localCurrency } from "@/lib/hotels";
import { getProfile } from "@/lib/traveller";


export const INSTRUCTIONS = `Chit is the signed-in customer's shopping and travel app, and Neon is Chit's own assistant. Work exactly like the Chit app: send what the customer wants done to ask_neon (keep passing the chat_id it returns, so Neon remembers the conversation), and let Neon do it. It searches, books with its live browser (shown in the card, where the customer watches and can take over), shops and emails just as it does in Chit, and the card streams its work live.
- While Neon is working, call neon_status with the run_id for its final answer, then relay it briefly; the cards already show the options and buttons.
- If Neon waits on the customer: for a browser step they use the card (Take over, then I'm done); for an email draft, show it and only on their yes call approve_neon_step.
- Payment always happens in the customer's own browser through the pay link. Never ask for card details.
- The other tools are quick lookups and shortcuts (trips, cart, orders, bookings, details, plan, company). book_flight / book_hotel return a pay link with saved details; cancelling is always two calls with the customer's yes in between.
- open_chit shows their whole Chit (trips, cart, orders, chats) in the chat.`;


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


const tripIdField = z.string().max(40).optional().describe("trip_id from an earlier search for the same trip; leave out to start a new trip");
const isDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** One MCP server per request (stateless), acting for this customer. */
export function chitMcpServer(who: Who): McpServer {
  const server = new McpServer({ name: "chit", title: config.storeName, version: "1.0.0", websiteUrl: config.siteUrl }, { instructions: INSTRUCTIONS });
  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerResource(
    "chit-cards",
    VIEW_URI,
    { title: "Chit cards", description: "Flights, hotels, cars and carts from Chit, with Book and Check out buttons.", mimeType: "text/html;profile=mcp-app" },
    async () => {
      // The view streams Neon's live browser over a WebSocket to the browser service.
      const live = liveOrigin();
      // Stripe's embedded checkout and its card fields load inside the card (Stripe's own frames: Chit never sees the card).
      const stripeCsp = {
        connectDomains: ["https://api.stripe.com", "https://checkout.stripe.com", "https://merchant-ui-api.stripe.com", "https://m.stripe.network", "https://q.stripe.com", "https://r.stripe.com", "https://errors.stripe.com"],
        resourceDomains: ["https://js.stripe.com", "https://*.js.stripe.com", "https://b.stripecdn.com"],
        frameDomains: ["https://js.stripe.com", "https://*.js.stripe.com", "https://hooks.stripe.com", "https://checkout.stripe.com"],
      };
      const ui = { prefersBorder: false, csp: { ...stripeCsp, connectDomains: [...stripeCsp.connectDomains, ...(live ? [live] : [])] } };
      return { contents: [{ uri: VIEW_URI, mimeType: "text/html;profile=mcp-app", text: viewHtml(), _meta: { ui } }] };
    },
  );

  // For the view only (not the model): a live-view address for the customer's own chat browser, and "I'm done"
  // after they finished a step in it (a robot check, a sign-in) so Neon carries on.
  const APP_ONLY = { ui: { resourceUri: VIEW_URI, visibility: ["app"] } };
  server.registerTool(
    "browser_live",
    { title: "Live browser address", description: "For the Chit view: a short-lived live-view address for Neon's browser in one of the customer's chats.", inputSchema: { chat_id: z.string().max(40), session: z.string().max(80) }, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: APP_ONLY },
    guarded(who, "browser_live", async ({ chat_id, session }) => {
      if (!browserConfigured()) return txt("The live browser isn't switched on.", true);
      const c = await prisma.assistantChat.findUnique({ where: { id: chat_id }, select: { customerId: true, browserSessionId: true } });
      if (c?.customerId !== who.customerId || c.browserSessionId !== session) return txt("This browser has closed.", true);
      return { ...txt("ok"), structuredContent: mintLiveUrl(session) };
    }),
  );
  server.registerTool(
    "browser_done",
    { title: "Done in the browser", description: "For the Chit view: the customer finished the step Neon asked for in its browser.", inputSchema: { run_id: z.string().max(40), step_id: z.string().max(40) }, annotations: { readOnlyHint: false, openWorldHint: false }, _meta: APP_ONLY },
    guarded(who, "browser_done", async ({ run_id, step_id }) => {
      const r = await getRun(run_id);
      const c = r ? await prisma.assistantChat.findUnique({ where: { id: r.chatId }, select: { customerId: true } }) : null;
      if (!r || c?.customerId !== who.customerId) return txt("Unknown run.", true);
      const res = await resumeRun(run_id, step_id);
      return res.status === 200 ? txt("Neon is carrying on.") : txt(JSON.stringify(res.body), true);
    }),
  );

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
        _meta: UI,
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
        return withCards({ trip_id: chatId, results: groups, trip_url: `${config.siteUrl}/c/${chatId}` }, viewCards(items, chatId), { title: title });
      }),
    );

    server.registerTool(
      "get_flight",
      { title: "Check a flight", description: "Re-check one flight offer now: current price, refund and change rules, extra bag prices, and its book_url.", inputSchema: { offer_id: z.string().max(80), trip_id: tripIdField }, annotations: ro, _meta: UI },
      guarded(who, "get_flight", async ({ offer_id, trip_id }) => {
        const { result, text } = await runConnector(duffelConnector.run, "get_flight", { offer_id }, trip_id ?? "mcp");
        if (result.isError) return txt(text, true);
        const chatId = await tripChat(who, trip_id, "Flight");
        const { flightDetails } = await import("@/lib/flights");
        const card = await flightDetails(offer_id).then((d) => d.card).catch(() => null);
        return withCards({ ...JSON.parse(text), book_url: link(`/flights/book/${encodeURIComponent(offer_id)}`, chatId), trip_id: chatId }, card ? viewCards([card], chatId) : []);
      }),
    );
  }

  if (liteapiConnector.enabled()) {
    server.registerTool(
      "search_hotels",
      {
        title: "Search hotels",
        description:
          "Search live hotel rates in a city for the dates (one live search). Returns 6 picks by default with an ISO currency on every price: total for the stay (room, taxes charged at booking and fee), per-night price, pay_at_hotel (taxes the hotel collects at check-in, not in total), room, meals, refundability with the free-cancellation deadline, and a book_url where the customer pays. hotel_name puts that hotel first or says it has no rooms. next_cursor pages through the rest of the same search without searching again.",
        inputSchema: {
          city: z.string().max(60),
          country_code: z.string().length(2).describe("2-letter ISO country code"),
          checkin: isDate,
          checkout: isDate,
          adults: z.number().int().min(1).max(8).default(1),
          child_ages: z.array(z.number().int().min(0).max(17)).max(6).default([]),
          max_price_per_night: z.number().min(0).default(0).describe("0 for any"),
          min_stars: z.number().int().min(0).max(5).default(0),
          hotel_name: z.string().max(80).optional().describe("A hotel the customer named, e.g. 'Lakeview Signature': matches go first"),
          currency: z.string().length(3).optional().describe("ISO currency for prices, e.g. CAD; default the customer's local currency"),
          max_results: z.number().int().min(1).max(30).default(6),
          cursor: z.string().max(30).optional().describe("next_cursor from the previous search_hotels: the next hotels from that same search, no new search"),
          trip_id: tripIdField,
        },
        annotations: ro,
        _meta: UI,
      },
      guarded(who, "search_hotels", async ({ trip_id, ...s }) => {
        const currency = s.currency?.toUpperCase() || localCurrency(await getProfile({ customerId: who.customerId, visitorId: null }).then((p) => p?.country || p?.passportCountry, () => null));
        const { result, items, text } = await runConnector(liteapiConnector.run, "find_hotels", { ...s, currency }, "mcp");
        if (result.isError) return txt(text, true);
        if (!items.length) return txt({ ...JSON.parse(text), note: "No hotels matched. Try a higher budget, fewer stars or other dates." });
        const chatId = await tripChat(who, trip_id, `Hotels in ${s.city}, ${s.checkin}`);
        const out = JSON.parse(text) as { picks?: Array<Record<string, unknown>> };
        for (const p of out.picks ?? []) p.book_url = link(`/hotels/book/${encodeURIComponent(String(p.offer_id))}`, chatId);
        await record(chatId, `Find a hotel in ${s.city}, ${s.checkin} to ${s.checkout}`, `I found ${items.length} hotel${items.length === 1 ? "" : "s"} for you in ${who.clientName}. Tap Book on the one you want.`, items);
        return withCards({ trip_id: chatId, ...out, trip_url: `${config.siteUrl}/c/${chatId}` }, viewCards(items, chatId), { title: `${s.city}, ${s.checkin} → ${s.checkout}` });
      }),
    );
  }

  server.registerTool(
    "find_rental_car",
    {
      title: "Find a rental car",
      description:
        "Rent a car exactly as Chit does: Neon searches Discover Cars in its live browser (the customer watches it in the card and can take over), picks the right car for the customer (residence rules included), fills the booking up to payment and returns the pay link. Same as ask_neon with a car request.",
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
      _meta: UI,
    },
    guarded(who, "find_rental_car", async ({ location, city, country_code, airport, pickup, dropoff, trip_id }) => {
      if (dropoff < pickup) return txt("The drop-off date must be on or after the pick-up date.", true);
      // Exactly as in Chit: Neon searches Discover Cars in its live browser (shown in the card), picks the right
      // car, fills the booking up to payment and hands over the pay link.
      const where = `${location}${airport ? ` (${airport.toUpperCase()})` : ""}, ${city}, ${country_code.toUpperCase()}`;
      return neonOut(await askNeon(who, `Rent me a car at ${where}, picking up ${pickup} and dropping off ${dropoff}. Find the best car and take the booking as far as payment, then give me the pay link.`, trip_id));
    }),
  );

  server.registerTool(
    "my_trips",
    {
      title: "My trips",
      description:
        "The customer's booked Chit trips (paid flights, hotels and rental cars): each trip's itinerary in time order and its receipts (booking numbers, confirmation codes, amounts, status) with links. Upcoming trips first.",
      inputSchema: { include_past: z.boolean().default(false).describe("Also list past trips"), limit: z.number().int().min(1).max(20).default(8) },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: UI,
    },
    guarded(who, "my_trips", async ({ include_past, limit }) => {
      const all = await tripsFor({ customerId: who.customerId, where: { customerId: who.customerId } });
      const trips = all.filter((t) => include_past || t.phase !== "past").slice(0, limit);
      if (!trips.length) return txt({ trips: [], note: all.length ? "No upcoming trips. Ask with include_past for past ones." : "No trips yet: nothing booked and paid for." });
      const abs = (h: string | null) => (h && h.startsWith("/") ? `${config.siteUrl}${h}` : h);
      const compact = trips.map((t) => ({
        trip_id: t.chatId,
        title: t.title,
        dates: [t.start, t.end].filter(Boolean).join(" → "),
        status: t.cancelled ? "cancelled" : t.phase,
        itinerary: t.itinerary.map((i) => `${i.when ?? "?"} · ${i.title}${i.detail ? ` · ${i.detail}` : ""}`),
        receipts: t.receipts.map((r) => ({ kind: r.kind, title: r.title, number: r.number, confirmation: r.confirmation ?? undefined, status: r.status, amount: r.amount, link: abs(r.href) ?? undefined })),
      }));
      const cards: ViewCard[] = compact.map((t) => ({
        kind: "trip",
        id: t.trip_id,
        title: t.title,
        subtitle: `${t.dates}${t.status === "upcoming" ? "" : ` · ${t.status}`}`,
        lines: t.itinerary.slice(0, 8),
        badges: t.receipts.map((r) => `${r.kind}: ${r.confirmation ?? r.number ?? r.status}`),
        actions: [{ label: "Open trip in Chit", url: `${config.siteUrl}/c/${t.trip_id}`, primary: true }],
      }));
      return withCards({ trips: compact, more: all.length > trips.length ? `${all.length - trips.length} more (older or past)` : undefined }, cards, { title: "Your trips" });
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

  server.registerTool(
    "open_chit",
    { title: "Open Chit", description: "Show the customer's Chit in the chat: tabs for their trips, cart, orders and Neon chats, with buttons (full screen available). Use when they ask to see their Chit, account or everything.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: UI },
    guarded(who, "open_chit", async () => ({ ...txt({ shown: "The customer's Chit (trips, cart, orders, chats) is open in the card." }), structuredContent: { home: true, result: "The customer's Chit (trips, cart, orders, chats) is open in the card." } })),
  );

  /* ---------- Shopping: Chit's catalog and the customer's Chit cart (the same cart as on their phone) ---------- */

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: "Keyword search over Chit's live catalog (millions of products shipped from factories, many with Canadian or US stock). Returns pid, title and starting price in USD. Use 1-3 word queries; run several for different parts.",
      inputSchema: { query: z.string().min(2).max(60), from_canada: z.boolean().default(false).describe("Only Canadian-warehouse stock (3-7 day delivery in Canada)"), page: z.number().int().min(1).max(5).default(1) },
      annotations: ro,
    },
    guarded(who, "search_products", async ({ query, from_canada, page }) => {
      const { hits, total } = await searchCatalog(query, page, from_canada ? "CA" : undefined);
      return txt({ total, products: hits.slice(0, 15).map((h) => ({ pid: h.pid, title: h.title, from_price_usd: (h.fromCents / 100).toFixed(2) })), next: "Call get_product with a pid for its options, stock and shipping, then add_to_cart." });
    }),
  );

  server.registerTool(
    "get_product",
    { title: "Product options", description: "One product's purchasable options (variant_id, price, stock), whether it ships to the customer and the description. Call before add_to_cart.", inputSchema: { pid: z.string().min(3).max(60) }, annotations: ro },
    guarded(who, "get_product", async ({ pid }) => {
      const r = await acting.run({ customerId: who.customerId }, () => catalogTool("get_product", { pid }, ""));
      return txt(typeof r.content === "string" ? r.content : JSON.stringify(r.content), !!r.isError);
    }),
  );

  server.registerTool(
    "add_to_cart",
    {
      title: "Add to cart",
      description: "Add a product option to the customer's Chit cart (the same cart they see in Chit on any device). Stock is re-checked live. Returns the cart with a checkout link.",
      inputSchema: { variant_id: z.string().min(3).max(60).describe("variant_id from get_product"), quantity: z.number().int().min(1).max(999).default(1) },
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: UI,
    },
    guarded(who, "add_to_cart", async ({ variant_id, quantity }) => {
      return acting.run({ customerId: who.customerId }, async () => {
        const cartId = await getOrCreateCartId();
        const r = await catalogTool("add_to_cart", { variant_id, quantity }, cartId);
        if (r.isError) return txt(String(r.content), true);
        await prisma.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } }).catch(() => {});
        const cart = await cartView(cartId);
        return withCards({ added: String(r.content), cart: cart.summary }, cart.cards);
      });
    }),
  );

  server.registerTool(
    "view_cart",
    { title: "My cart", description: "What's in the customer's Chit cart: each line (line_id, product, option, quantity, price), subtotal, shipping to them, and the checkout link.", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: UI },
    guarded(who, "view_cart", async () =>
      acting.run({ customerId: who.customerId }, async () => {
        const cartId = await getCartId();
        if (!cartId) return withCards({ items: [], note: "The cart is empty." }, [], {});
        const cart = await cartView(cartId);
        return withCards(cart.summary, cart.cards);
      }),
    ),
  );

  server.registerTool(
    "update_cart",
    { title: "Change cart quantity", description: "Change a cart line's quantity (0 removes it). line_id comes from view_cart.", inputSchema: { line_id: z.string().max(40), quantity: z.number().int().min(0).max(999) }, annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }, _meta: UI },
    guarded(who, "update_cart", async ({ line_id, quantity }) =>
      acting.run({ customerId: who.customerId }, async () => {
        const cartId = await getCartId();
        const line = cartId ? await prisma.cartItem.findFirst({ where: { id: line_id, cartId } }) : null;
        if (!cartId || !line) return txt("That line isn't in the customer's cart. Call view_cart for current line_ids.", true);
        if (quantity === 0) await prisma.cartItem.delete({ where: { id: line.id } });
        else await prisma.cartItem.update({ where: { id: line.id }, data: { quantity } });
        await prisma.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } }).catch(() => {});
        const cart = await cartView(cartId);
        return withCards({ updated: true, cart: cart.summary }, cart.cards);
      }),
    ),
  );

  /* ---------- Neon: the customer's chats, and Neon itself (everything it can do, with its live browser) ---------- */

  server.registerTool(
    "my_chats",
    { title: "My Neon chats", description: "The customer's recent chats with Neon in Chit (chat_id, title, last updated), newest first.", inputSchema: { limit: z.number().int().min(1).max(30).default(10) }, annotations: { readOnlyHint: true, openWorldHint: false } },
    guarded(who, "my_chats", async ({ limit }) => {
      const chats = await prisma.assistantChat.findMany({ where: { customerId: who.customerId, userTurns: { gt: 0 } }, orderBy: { updatedAt: "desc" }, take: limit, select: { id: true, title: true, updatedAt: true, work: true } });
      return txt({ chats: chats.map((c) => ({ chat_id: c.id, title: c.title, updated: c.updatedAt.toISOString().slice(0, 16).replace("T", " "), ...(c.work ? { work: true } : {}), url: `${config.siteUrl}/c/${c.id}` })) });
    }),
  );

  server.registerTool(
    "read_chat",
    { title: "Read a Neon chat", description: "The last messages of one of the customer's Neon chats, with the cards Neon showed (flights, hotels, cars, carts, emails).", inputSchema: { chat_id: z.string().max(40), last: z.number().int().min(1).max(30).default(10) }, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: UI },
    guarded(who, "read_chat", async ({ chat_id, last }) => {
      const c = await prisma.assistantChat.findUnique({ where: { id: chat_id }, select: { customerId: true, title: true, uiJson: true } });
      if (!c || c.customerId !== who.customerId) return txt("That chat isn't one of this customer's chats. Call my_chats.", true);
      const ui = (JSON.parse(c.uiJson || "[]") as Array<{ role: string; text?: string; items?: ConnectorItem[]; at?: string }>).slice(-last);
      const items = ui.flatMap((e) => e.items ?? []);
      return withCards(
        { title: c.title, messages: ui.map((e) => ({ from: e.role === "user" ? "customer" : "neon", text: (e.text ?? "").slice(0, 2000), ...(e.items?.length ? { cards: e.items.map((i) => i.kind) } : {}) })), url: `${config.siteUrl}/c/${chat_id}` },
        viewCards(items.slice(-12), chat_id),
        { title: c.title },
      );
    }),
  );

  server.registerTool(
    "ask_neon",
    {
      title: "Chit (Neon)",
      description:
        "The Chit app itself: pass the customer's request to Neon, Chit's own assistant, and it does exactly what it does in the Chit app, with its live browser (shown in the card, where the customer watches and can take over): plan and book trips (flights, hotels, rental cars up to payment), shop Amazon and Chit's catalog, email hotels, save details, and everything else in Chit. Use this by default for anything the customer wants done in Chit. Pass chat_id from the previous ask_neon in this conversation so Neon remembers it. The card streams Neon's work live; if the result says it's still working, call neon_status with the run_id to get the final answer.",
      inputSchema: { message: z.string().min(2).max(4000).describe("What to do, in the customer's words, with all the details you know (dates, places, names)"), chat_id: z.string().max(40).optional() },
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: UI,
    },
    guarded(who, "ask_neon", async ({ message, chat_id }) => neonOut(await askNeon(who, message, chat_id))),
  );

  server.registerTool(
    "neon_status",
    { title: "Neon's progress", description: "Wait for (up to about a minute) and get Neon's reply to an ask_neon run that was still working.", inputSchema: { run_id: z.string().max(40) }, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: UI },
    guarded(who, "neon_status", async ({ run_id }) => {
      const r = await getRun(run_id);
      const c = r ? await prisma.assistantChat.findUnique({ where: { id: r.chatId }, select: { customerId: true } }) : null;
      if (!r || c?.customerId !== who.customerId) return txt("Unknown run_id.", true);
      return neonOut(await waitNeon(run_id));
    }),
  );

  server.registerTool(
    "neon_watch",
    {
      title: "Neon live",
      description: "For the Chit card: Neon's run as it happens (text so far, cards, the step it's waiting on, its browser).",
      inputSchema: { run_id: z.string().max(40) },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: VIEW_URI, visibility: ["app"] } },
    },
    async ({ run_id }) => {
      // Polled every second or so by the card: not rate-limited or logged like the other tools, but owner-only.
      const r = await getRun(run_id);
      const c = r ? await prisma.assistantChat.findUnique({ where: { id: r.chatId }, select: { customerId: true, browserSessionId: true } }) : null;
      if (!r || c?.customerId !== who.customerId) return txt("Unknown run.", true);
      const { run, done } = r;
      const items = (done ? ((done.entry as { items?: ConnectorItem[] }).items ?? []) : run.partial.items ?? []).filter((i) => i.kind !== "browser");
      const live = {
        status: run.status,
        text: done ? done.entry.text : run.partial.text,
        steps: run.partial.steps?.slice(-1) ?? [],
        cards: viewCards(items, r.chatId),
        pending: run.pending ? { id: run.pending.id, kind: run.pending.kind, message: run.pending.message, inBrowser: !!run.pending.browser } : null,
        session: run.pending?.browser?.sessionId ?? (isActive(run.status) ? c.browserSessionId : null) ?? null,
        error: run.error,
        chat_url: `${config.siteUrl}/c/${r.chatId}`,
      };
      return { ...txt("ok"), structuredContent: live };
    },
  );

  server.registerTool(
    "approve_neon_step",
    {
      title: "Approve Neon's step",
      description: "Approve the step Neon is waiting on (for example: send the email draft it showed). Only after the customer has said yes to exactly that step. Steps in the live browser (a robot check, a sign-in) can't be approved here: give the customer the chat link instead.",
      inputSchema: { run_id: z.string().max(40), step_id: z.string().max(40) },
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: UI,
    },
    guarded(who, "approve_neon_step", async ({ run_id, step_id }) => {
      const r = await getRun(run_id);
      const c = r ? await prisma.assistantChat.findUnique({ where: { id: r.chatId }, select: { customerId: true } }) : null;
      if (!r || c?.customerId !== who.customerId) return txt("Unknown run_id.", true);
      if (r.run.pending?.browser) return txt(`This step happens in Neon's live browser. The customer opens ${config.siteUrl}/c/${r.chatId} to do it.`, true);
      const res = await resumeRun(run_id, step_id);
      if (res.status !== 200) return txt(JSON.stringify(res.body), true);
      return neonOut(await waitNeon(run_id));
    }),
  );

  registerMoreTools(server, who);

  return server;
}

/* ---------- Cart and Neon helpers ---------- */

/** The cart as a summary for the model (with line ids) and a card for the view. */
async function cartView(cartId: string) {
  const cart = await loadCart(cartId);
  const items = cart?.items ?? [];
  const totals = await catalogTool("view_cart", {}, cartId);
  const parsed = (() => {
    try {
      return JSON.parse(String(totals.content)) as { subtotal?: string; shipping?: string; bulk_savings?: string | null };
    } catch {
      return {};
    }
  })();
  const priced = priceOrder(items.map((i) => ({ listCents: i.variant.priceCents, costCents: i.variant.offer?.cjSupplierVariant.supplierPriceCents, quantity: i.quantity })));
  const lines = items.map((i, n) => ({ line_id: i.id, product: i.variant.product.title, option: i.variant.name, quantity: i.quantity, line_total: formatMoney(priced.unitCents[n] * i.quantity) }));
  const checkout = `${config.siteUrl}/cart`;
  const summary = { items: lines, boxes: cart?.boxes.length ?? 0, subtotal: parsed.subtotal ?? formatMoney(priced.totalCents), bulk_savings: parsed.bulk_savings ?? undefined, shipping: parsed.shipping, checkout_url: checkout, note: "The customer checks out on Chit (signed in with the same account) and pays there." };
  const cards: ViewCard[] = lines.length
    ? [
        {
          kind: "cart",
          id: cartId,
          title: "Your Chit cart",
          subtitle: parsed.shipping ? (/: from /.test(parsed.shipping) ? `Shipping to ${parsed.shipping}` : parsed.shipping) : undefined,
          lines: lines.map((l) => `${l.quantity} × ${l.product}${l.option && l.option !== "Default" ? ` (${l.option})` : ""} · ${l.line_total}`),
          price: summary.subtotal,
          priceNote: "subtotal",
          badges: parsed.bulk_savings ? [`Bulk savings ${parsed.bulk_savings}`] : [],
          cartLines: lines.map((l) => ({ id: l.line_id, label: `${l.product}${l.option && l.option !== "Default" ? ` (${l.option})` : ""}`, quantity: l.quantity, total: l.line_total })),
          actions: [{ label: "Check out", tool: { name: "checkout_cart", args: {} }, primary: true }, { label: "Open cart in Chit", url: checkout }],
        },
      ]
    : [];
  return { summary, cards };
}

type NeonResult =
  | { state: "error"; message: string }
  | { state: "working"; runId: string; chatId: string; note: string; session?: string | null }
  | { state: "waiting"; runId: string; chatId: string; step: { id: string; kind: string; message: string; inBrowser: boolean; session?: string }; partial: string; items: ConnectorItem[] }
  | { state: "done"; runId: string; chatId: string; text: string; items: ConnectorItem[] }
  | { state: "failed"; runId: string; chatId: string; message: string };

/** ask_neon answers after this (the card keeps streaming); neon_status waits up to the longer one. */
const ASK_WAIT_MS = 8_000;
const STATUS_WAIT_MS = 45_000;

async function askNeon(who: Who, message: string, chatId: string | undefined): Promise<NeonResult> {
  if (!assistantConfigured()) return { state: "error", message: "Neon isn't switched on." };
  const allowance = await aiAllowance({ customerId: who.customerId, visitorId: null });
  if (allowance.remaining <= 0) return { state: "error", message: `${limitMessage(allowance)} Plans: ${config.siteUrl}/plans` };
  let chat = chatId ? await prisma.assistantChat.findUnique({ where: { id: chatId } }) : null;
  if (chatId && chat?.customerId !== who.customerId) return { state: "error", message: "That chat isn't one of this customer's chats." };
  const isNew = !chat;
  chat ??= await prisma.assistantChat.create({ data: { customerId: who.customerId, title: message.replace(/\s+/g, " ").slice(0, 48) } });
  const theChat = chat;
  return acting.run({ customerId: who.customerId }, async () => {
    const cartId = await getOrCreateCartId();
    const r = await acceptRun({ chat: theChat, isNew, clientRequestId: randomBytes(12).toString("base64url"), text: message, images: [], docs: [], voice: false, customerId: who.customerId, visitorId: "", cartId });
    if (!r.ok) return { state: "error", message: r.body.error } as NeonResult;
    // Runs in the background like a message sent in the app; the acting context follows it.
    if (r.start) void r.start();
    return waitNeon(r.accepted.run.id, ASK_WAIT_MS);
  });
}

/** Waits for the run to finish or stop on a step, up to `ms`. */
async function waitNeon(runId: string, ms = STATUS_WAIT_MS): Promise<NeonResult> {
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (!r) return { state: "error", message: "Unknown run." };
    const { run, done, chatId } = r;
    if (run.status === "completed" && done) return { state: "done", runId, chatId, text: done.entry.text, items: ((done.entry as { items?: ConnectorItem[] }).items ?? []) };
    if (run.status === "waiting" && run.pending)
      return { state: "waiting", runId, chatId, step: { id: run.pending.id, kind: run.pending.kind, message: run.pending.message, inBrowser: !!run.pending.browser, session: run.pending.browser?.sessionId }, partial: run.partial.text, items: (run.partial as { items?: ConnectorItem[] }).items ?? [] };
    if (!isActive(run.status)) return { state: "failed", runId, chatId, message: run.error ?? `Neon stopped (${run.status}).` };
    if (Date.now() - t0 > ms) {
      const session = (await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { browserSessionId: true } }))?.browserSessionId;
      return { state: "working", runId, chatId, session, note: "Neon is still working; the customer sees it live in the card. Call neon_status with this run_id for the result." };
    }
    await new Promise((res) => setTimeout(res, 800));
  }
}

function neonOut(r: NeonResult): Out {
  const out = neonOutRaw(r);
  // The card follows the run live (neon_watch) until it ends, like Neon's bubble in the Chit chat.
  if (r.state !== "error") {
    const text = out.content[0]?.text ?? "";
    let result: unknown = text;
    try {
      result = JSON.parse(text);
    } catch {}
    out.structuredContent = { result, cards: [], ...(out.structuredContent ?? {}), neon: { runId: r.runId, chatId: r.chatId } };
  }
  return out;
}

function neonOutRaw(r: NeonResult): Out {
  if (r.state === "error") return txt(r.message, true);
  const chat_url = `${config.siteUrl}/c/${r.chatId}`;
  if (r.state === "failed") return txt({ run_id: r.runId, chat_url, error: r.message }, true);
  if (r.state === "working") {
    const out = { status: "working", run_id: r.runId, chat_id: r.chatId, chat_url, note: r.note };
    return r.session ? withCards(out, [browserCard(r.chatId, r.session)], { title: "Neon is working" }) : txt(out);
  }
  if (r.state === "waiting")
    return withCards(
      {
        status: "waiting_for_customer",
        run_id: r.runId,
        chat_id: r.chatId,
        chat_url,
        step: r.step,
        so_far: r.partial.slice(0, 3000),
        how: r.step.inBrowser
          ? "This step happens in Neon's live browser, shown in the card: the customer taps Take over, does it, then taps I'm done (or opens chat_url in Chit). For payment it's their own browser via the pay link; Neon notices by itself. Then call neon_status."
          : "Show the customer exactly what Neon is asking. Only if they say yes, call approve_neon_step with run_id and step.id.",
      },
      [
        ...viewCards(r.items.filter((i) => !(r.step.session && i.kind === "browser")), r.chatId),
        ...(r.step.session ? [browserCard(r.chatId, r.step.session, undefined, { runId: r.runId, stepId: r.step.id, needs: r.step.message })] : []),
      ],
      { title: "Neon is waiting for you", ...(r.step.session ? {} : { footer: r.step.message }) },
    );
  return withCards({ status: "done", run_id: r.runId, chat_id: r.chatId, chat_url, neon: r.text, cards: r.items.map((i) => i.kind) }, viewCards(r.items, r.chatId), { title: "From Neon" });
}
