import { prisma } from "@/lib/db";
import { neonKeyOk, ownerWho } from "@/lib/neon-browser";
import { acting } from "@/lib/acting";
import { getOffer } from "@/lib/duffel";
import { priceWithFee } from "@/lib/flights";
import { flightPrefill, hotelPrefill } from "@/lib/traveller";
import { startFlightCheckout, type StartResult } from "@/lib/flight-booking";
import { startHotelCheckout } from "@/lib/hotel-booking";
import { offerCard } from "@/lib/hotels";
import { publishableKey, isEmbedded } from "@/lib/stripe-customer";
import { stripe } from "@/lib/stripe";

// Neon Browser → Chit: start a flight/hotel booking for the owner with saved details, and return Stripe's
// embedded checkout (client secret) so payment happens inside the chat. Key-guarded, owner-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!neonKeyOk(req.headers.get("x-neon-key"))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const who = await ownerWho();
  if (!who) return Response.json({ error: "No owner account is configured on Chit." }, { status: 500 });

  let body: { kind?: unknown; offerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Send JSON with kind and offerId." }, { status: 400 });
  }
  const kind = body.kind === "hotel" ? "hotel" : body.kind === "flight" ? "flight" : null;
  const offerId = String(body.offerId ?? "");
  if (!kind || !offerId) return Response.json({ error: "kind ('flight' or 'hotel') and offerId are required." }, { status: 400 });

  const embedded = !!publishableKey();
  const r: StartResult = await acting.run({ customerId: who.customerId, embedded }, async () => {
    if (kind === "flight") {
      const offer = await getOffer(offerId).catch(() => null);
      if (!offer) return { error: "That fare is no longer available. Search again." };
      const form = new FormData();
      for (const [k, v] of Object.entries((await flightPrefill()).values)) form.set(k, v);
      return startFlightCheckout({ offerId, shownCents: priceWithFee(offer.total_amount), form, customerId: who.customerId });
    }
    const card = await offerCard(offerId);
    if (!card) return { error: "That room is no longer available. Search again." };
    const form = new FormData();
    for (const [k, v] of Object.entries((await hotelPrefill()).values)) form.set(k, v);
    return startHotelCheckout({ offerId, shownCents: card.priceCents, form, customerId: who.customerId });
  });

  if (r.error || !r.url) return Response.json({ error: r.error ?? "Couldn't start the booking." }, { status: 400 });
  const sid = /(cs_[A-Za-z0-9_]+)/.exec(r.url)?.[1];
  if (embedded && sid) {
    const s = await stripe().checkout.sessions.retrieve(sid);
    if (isEmbedded(s.ui_mode) && s.client_secret) return Response.json({ clientSecret: s.client_secret, publishableKey: publishableKey() });
  }
  return Response.json({ payUrl: r.url });
}
