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
  /** Which search found it ("Cheapest", "Nonstop", "±2 days"…). */
  group?: string;
}

/** A grocery list or recipe Neon built, opened and paid for on Instacart. */
export interface GroceryList {
  kind: "grocery";
  /** Our own id for the card (Instacart gives back only a link). */
  id: string;
  title: string;
  /** The Instacart page: the shopper picks a store and checks out there. */
  url: string;
  recipe: boolean;
  items: Array<{ name: string; quantity: number; unit: string }>;
  group?: string;
}

/** Anything a connector shows in the chat, told apart by `kind`. New connectors add their own card here. */
export type ConnectorItem = FlightCard | GroceryList;

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
