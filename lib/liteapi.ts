// LiteAPI (Nuitee): hotel rates, price locks (prebook) and bookings across 2M+ hotels. A sandbox key (it starts
// with "sand_") books test stays that charge nothing; a production key books real rooms paid by the card on
// the LiteAPI account. We charge the shopper first with Stripe, then book with that account card.
//
// LITEAPI_KEY       sandbox or production key from the LiteAPI dashboard
// LITEAPI_URL       optional, for tests (default https://api.liteapi.travel/v3.0)
// LITEAPI_BOOK_URL  optional, for tests (default https://book.liteapi.travel/v3.0)

export function liteapiConfigured(): boolean {
  return !!process.env.LITEAPI_KEY?.trim();
}

export function liteapiTestMode(): boolean {
  return (process.env.LITEAPI_KEY?.trim() ?? "").startsWith("sand_");
}

const apiUrl = () => (process.env.LITEAPI_URL?.trim() || "https://api.liteapi.travel/v3.0").replace(/\/+$/, "");
const bookUrl = () => (process.env.LITEAPI_BOOK_URL?.trim() || "https://book.liteapi.travel/v3.0").replace(/\/+$/, "");

export class LiteapiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

async function call<T>(base: string, path: string, body: unknown, timeoutMs: number, method: "POST" | "PUT" = "POST"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { "X-API-Key": process.env.LITEAPI_KEY?.trim() ?? "", "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new LiteapiError(`LiteAPI didn't answer (${e instanceof Error ? e.message : e})`);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; description?: string } | string; message?: string } & T;
  if (!res.ok) {
    const err = typeof json.error === "string" ? json.error : (json.error?.message ?? json.error?.description ?? json.message);
    throw new LiteapiError(`LiteAPI: ${err ?? `HTTP ${res.status}`}`, res.status);
  }
  return json;
}

export interface Money {
  amount: number;
  currency: string;
}
export interface LiteRate {
  name?: string;
  boardName?: string;
  retailRate?: { total?: Money[] };
  cancellationPolicies?: { refundableTag?: string };
}
export interface LiteRoomType {
  offerId: string;
  rates?: LiteRate[];
  offerRetailRate?: Money;
}
export interface LiteHotel {
  id: string;
  name?: string;
  main_photo?: string;
  thumbnail?: string;
  address?: string;
  city?: string;
  rating?: number;
  stars?: number;
  starRating?: number;
  latitude?: number;
  longitude?: number;
}
export interface RatesResponse {
  data?: Array<{ hotelId: string; roomTypes?: LiteRoomType[] }>;
  hotels?: LiteHotel[];
}

export interface RatesQuery {
  cityName: string;
  countryCode: string;
  checkin: string;
  checkout: string;
  adults: number;
  childAges: number[];
  currency: string;
  guestNationality: string;
}

export function searchRates(q: RatesQuery): Promise<RatesResponse> {
  return call<RatesResponse>(
    apiUrl(),
    "/hotels/rates",
    {
      cityName: q.cityName,
      countryCode: q.countryCode,
      checkin: q.checkin,
      checkout: q.checkout,
      currency: q.currency,
      guestNationality: q.guestNationality,
      occupancies: [{ adults: q.adults, children: q.childAges }],
      includeHotelData: true,
      limit: 60,
      timeout: 10,
    },
    20_000,
  );
}

export interface Prebook {
  prebookId: string;
  price: number;
  currency: string;
  hotelId?: string;
}

/** Locks the rate and returns its current price (it can differ from the search). */
export async function prebook(offerId: string): Promise<Prebook> {
  const r = await call<{ data?: Prebook }>(bookUrl(), "/rates/prebook", { offerId, usePaymentSdk: false }, 30_000);
  if (!r.data?.prebookId || !Number.isFinite(Number(r.data.price))) throw new LiteapiError("LiteAPI: the room couldn't be held");
  return { ...r.data, price: Number(r.data.price) };
}

export interface LiteBooking {
  bookingId: string;
  status?: string;
  hotelConfirmationCode?: string;
  price?: number;
  currency?: string;
}

/** Books the held rate, paid by the LiteAPI account's card (a simulated card on a sandbox key). */
export async function bookRate(prebookId: string, guest: { firstName: string; lastName: string; email: string }, ref: string): Promise<LiteBooking> {
  const r = await call<{ data?: LiteBooking }>(
    bookUrl(),
    "/rates/book",
    {
      prebookId,
      clientReference: ref,
      holder: guest,
      payment: { method: "ACC_CREDIT_CARD" },
      guests: [{ occupancyNumber: 1, ...guest }],
    },
    60_000,
  );
  if (!r.data?.bookingId) throw new LiteapiError("LiteAPI: no booking id in the answer");
  return r.data;
}

export interface LiteCancellation {
  bookingId?: string;
  status?: string;
  cancellation_fee?: number;
  /** What LiteAPI gives back to our account card. */
  refund_amount?: number;
  currency?: string;
}

/** Cancels a booking under its cancellation policy (refused for non-refundable rates or past the deadline). */
export async function cancelBooking(bookingId: string): Promise<LiteCancellation> {
  const r = await call<{ data?: LiteCancellation }>(bookUrl(), `/bookings/${encodeURIComponent(bookingId)}`, undefined, 60_000, "PUT");
  return r.data ?? {};
}
