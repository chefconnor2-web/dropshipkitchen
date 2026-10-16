// Flight cards as the chat shows them. Shared by the server (lib/flights.ts builds them from Duffel offers)
// and the browser (components/chat renders them), so nothing here may import server code.

export interface FlightSegment {
  from: string;
  to: string;
  /** Local time at the airport, ISO without offset (as Duffel gives it). */
  depart: string;
  arrive: string;
  carrier: string;
  flight: string;
}

export interface FlightSlice {
  from: string;
  fromCity: string;
  to: string;
  toCity: string;
  depart: string;
  arrive: string;
  durationMin: number;
  stops: number;
  via: string[];
  segments: FlightSegment[];
}

export interface FlightCard {
  kind: "flight";
  /** Duffel offer id: what booking will use. Offers expire (see expiresAt). */
  id: string;
  airline: string;
  logo: string | null;
  /** What the shopper pays, our fee included, in `currency` (whole units ×100). */
  priceCents: number;
  currency: string;
  cabin: string;
  fareBrand: string | null;
  checkedBags: number;
  carryOn: number;
  refundable: boolean | null;
  changeable: boolean | null;
  slices: FlightSlice[];
  expiresAt: string;
  /** Change and refund before departure: "free", "fee" (with the fee), "no", or null when the airline doesn't say. */
  changeRule?: FareRule;
  refundRule?: FareRule;
  /** The airline lets this fare be held now and paid later (Hold this fare on the booking page). */
  holdable?: boolean;
  /** Every fare type for these exact flights (Basic, Standard, Flex…), cheapest first, this card's included. */
  fares?: FareOption[];
  /** Which search found it ("Cheapest", "Nonstop", "±2 days"…). */
  group?: string;
}

export type FareRule = { kind: "free" } | { kind: "fee"; fee: string } | { kind: "no" } | null;

/** One fare type for a flight: its own offer (what Book uses), price, bags and rules. */
export interface FareOption {
  id: string;
  brand: string;
  priceCents: number;
  checkedBags: number;
  carryOn: number;
  changeRule: FareRule;
  refundRule: FareRule;
}

/** "Free changes", "Changes $75", "No changes"; same for refunds. */
export function ruleLabel(r: FareRule | undefined, what: "changes" | "refund"): string | null {
  if (!r) return null;
  if (r.kind === "free") return what === "changes" ? "Free changes" : "Refundable";
  if (r.kind === "fee") return what === "changes" ? `Changes ${r.fee}` : `Refund minus ${r.fee}`;
  return what === "changes" ? "No changes" : "No refund";
}

/** The same flights (segments, flight numbers, times): different fare types of one trip share this key. */
export function itineraryKey(c: Pick<FlightCard, "slices">): string {
  return c.slices.map((s) => s.segments.map((g) => `${g.flight}@${g.depart}`).join("+")).join("|");
}

/** One hotel's best room for the dates, from LiteAPI. Booking re-checks the price first. */
export interface HotelCard {
  kind: "hotel";
  /** Our short id for the card and the booking link (LiteAPI's offer ids run to hundreds of characters). */
  id: string;
  /** LiteAPI's offer id: what the booking page prebooks. Missing on cards saved before it was added (id was it). */
  offerId?: string;
  hotelId: string;
  name: string;
  photo: string | null;
  stars: number | null;
  /** Guest rating out of 10, when LiteAPI has one. */
  rating: number | null;
  address: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  room: string;
  board: string;
  refundable: boolean | null;
  /** Free cancellation up to this moment ("2026-10-13 16:00 GMT"), when the rate is refundable and LiteAPI says. */
  freeCancelUntil?: string | null;
  /** Taxes and fees the hotel collects at check-in: not in `priceCents`, in their own currency ×100. */
  payAtHotel?: Array<{ amountCents: number; currency: string; description: string }>;
  /** Taxes already inside `priceCents` (shown so nobody pays them twice). */
  taxesIncluded?: { amountCents: number; currency: string } | null;
  checkin: string;
  checkout: string;
  nights: number;
  adults: number;
  childAges: number[];
  /** What the shopper pays for the whole stay, our fee included, in `currency` ×100. */
  priceCents: number;
  currency: string;
  group?: string;
}

/** Rental cars: a link to Discover Cars (our affiliate link) for the place and dates; the shopper books there. */
export interface CarBooking {
  confirmation?: string;
  /** Rental company, e.g. "Alamo". */
  supplier?: string;
  /** e.g. "Economy · Kia Rio or similar". */
  car?: string;
  /** As shown, e.g. "$123.40 USD". */
  price?: string;
  /** Local "YYYY-MM-DDTHH:MM" (or a date). */
  pickupAt?: string;
  dropoffAt?: string;
  /** Desk or address, e.g. "Miami Int'l Airport, Rental Car Center". */
  pickupPlace?: string;
  dropoffPlace?: string;
}

export interface CarRentalCard {
  kind: "car";
  id: string;
  /** Where they pick up, as the shopper would type it into the search ("Vancouver Airport (YVR)"). */
  location: string;
  pickup: string;
  dropoff: string;
  url: string;
  /** The link opens a search Neon filled in on Discover Cars in the live browser ("Continue on Discover Cars"). */
  filled?: boolean;
  /** Neon's pick from the results: the most economical sensible car, as Discover Cars showed it. */
  pick?: { car: string; price: string; supplier?: string; why?: string };
  /** The checkout Neon filled in, ready to pay in the shopper's own browser ("Pay on Discover Cars"). */
  pay?: { step: "payment" | "driver" };
  /** Booked: what the shopper's confirmation (their screenshot) shows, for the itinerary and receipts. */
  booked?: CarBooking;
  group?: string;
}

/** A supplier outside our catalog that Neon found on the web: the shopper contacts them for a quote. */
export interface SupplierCard {
  kind: "supplier";
  id: string;
  name: string;
  url: string;
  /** What they make or sell that matches ("300T four-column deep-drawing press"). */
  offer: string;
  location?: string;
  /** As listed, in words ("$18,000–25,000 / set"); never worked out by us. */
  price?: string;
  moq?: string;
  note?: string;
  group?: string;
}

/** A live browser Neon is driving (Amazon): the chat streams its screen, and the shopper can take over. */
export interface BrowserCard {
  kind: "browser";
  /** "br_" + the browser session id; the same card is updated in place. */
  id: string;
  /** The browser service session id. The live-view address (with a short-lived token) comes from
   *  GET /api/assistant/browser?chat=…&session=…, only for the chat's owner; it's never saved in the chat. */
  session: string;
  /** Old cards (before tokens were minted on demand) carried the address itself; ignored now. */
  live?: string;
  site: string;
  /** Set when Neon hands over: why the shopper should take over (captcha, sign in, check out). */
  handoff?: string;
  group?: string;
}

/**
 * The Amazon cart Neon filled, as one link the shopper opens in their own Safari or Amazon app (where they're
 * already signed in): Amazon's add-to-cart URL puts every item in THEIR cart. Neon never signs in for them.
 */
export interface CartLinkCard {
  kind: "cart-link";
  /** "cl_" + the browser session id; updated in place as items are added. */
  id: string;
  url: string;
  site: string;
  /** Distinct products and total units in the link. */
  products: number;
  units: number;
  /** What's in it, with Amazon's delivery estimate when it was added (for the trip's itinerary). */
  items?: Array<{ asin: string; quantity: number; title?: string; delivery?: string }>;
  group?: string;
}

/** A cart on another store (Shopify, WooCommerce, BigCommerce…) as that store's own add-to-cart link(s). */
export interface StoreCartCard {
  kind: "store-cart";
  /** "sc_" + the store's domain; a later cart for the same store replaces it. */
  id: string;
  store: string;
  platform: "shopify" | "woocommerce" | "bigcommerce" | "other";
  /** One link fills the cart (Shopify), or one per product. Empty when every line is added by hand. */
  links: Array<{ label: string; url: string }>;
  subtotal: string | null;
  lines: Array<{ title: string; option?: string; quantity: number; price: string | null; url: string; needsHand: boolean }>;
  group?: string;
}

/** An email Neon drafted for the shopper to approve (it's sent only after Approve & next), and how it went. */
export interface EmailDraftCard {
  kind: "email-draft";
  /** "em_" + random; updated in place when it's sent. */
  id: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  /** The hotel's front-desk address Neon found, and where it found it, when the shopper had it sent elsewhere (a test). */
  foundAddress?: string;
  foundAt?: string;
  /** The shopper's Gmail it will be sent from, or null (then it goes from the store, replies to the shopper). */
  from: string | null;
  /** Shown while Gmail isn't connected: where to connect it. */
  connectUrl?: string;
  status: "draft" | "sent" | "not_sent";
  note?: string;
  group?: string;
}

/** Anything a connector shows in the chat, told apart by `kind`. New connectors add their own card here. */
export type ConnectorItem = FlightCard | HotelCard | CarRentalCard | SupplierCard | BrowserCard | CartLinkCard | StoreCartCard | EmailDraftCard;

/** "$1,240" for a stay, in its own currency. */
export function stayPrice(c: Pick<HotelCard, "priceCents" | "currency">): string {
  return flightPrice({ priceCents: c.priceCents, currency: c.currency });
}

/** "CAD 1,240": the amount with its ISO code, so no price is ambiguous. */
export function isoPrice(c: Pick<HotelCard, "priceCents" | "currency">): string {
  const code = c.currency.toUpperCase();
  const whole = c.priceCents % 100 === 0;
  return `${code} ${(c.priceCents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** What the hotel collects at check-in ("CAD 49"), or null when nothing. */
export function payAtHotelLabel(c: Pick<HotelCard, "payAtHotel">): string | null {
  const fees = c.payAtHotel ?? [];
  if (!fees.length) return null;
  const byCur = new Map<string, number>();
  for (const f of fees) byCur.set(f.currency, (byCur.get(f.currency) ?? 0) + f.amountCents);
  return [...byCur].map(([currency, amountCents]) => isoPrice({ priceCents: amountCents, currency })).join(" + ");
}

/** Uber with the destination filled in (pickup is wherever the rider is). Opens the app on phones. */
export function uberLink(to: { name: string; address: string; latitude?: number | null; longitude?: number | null }): string {
  const q = new URLSearchParams({ action: "setPickup", pickup: "my_location", "dropoff[nickname]": to.name, "dropoff[formatted_address]": to.address });
  if (to.latitude != null && to.longitude != null) {
    q.set("dropoff[latitude]", String(to.latitude));
    q.set("dropoff[longitude]", String(to.longitude));
  }
  if (process.env.NEXT_PUBLIC_UBER_CLIENT_ID) q.set("client_id", process.env.NEXT_PUBLIC_UBER_CLIENT_ID);
  return `https://m.uber.com/ul/?${q}`;
}

/** "11h 30m". */
export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${String(m).padStart(2, "0")}m` : ""}` : `${m}m`;
}

/** "13:05" from a local ISO time. */
export function clock(iso: string): string {
  return iso.slice(11, 16);
}

/** "+1" when a slice lands on a later day than it left. */
export function dayShift(depart: string, arrive: string): string {
  const d = Math.round((Date.parse(arrive.slice(0, 10)) - Date.parse(depart.slice(0, 10))) / 86400_000);
  return d > 0 ? `+${d}` : "";
}

/** "Nov 3". */
export function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function stopsLabel(s: Pick<FlightSlice, "stops" | "via">): string {
  return s.stops === 0 ? "Nonstop" : `${s.stops} stop${s.stops > 1 ? "s" : ""}${s.via.length ? ` · ${s.via.join(", ")}` : ""}`;
}

export function flightPrice(c: Pick<FlightCard, "priceCents" | "currency">): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: c.currency, maximumFractionDigits: 0 }).format(c.priceCents / 100);
  } catch {
    return `${c.currency} ${Math.round(c.priceCents / 100)}`;
  }
}
