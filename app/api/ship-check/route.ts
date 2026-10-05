// Product-card shipping badges: POST {pids} → whether each ships to the shopper's country (from their
// ship-to cookie: their own choice, or the country guessed from their IP address). Unknown ones come back
// "pending" and are checked in the background; the cards ask again shortly.
import { getShipTo } from "@/lib/cart";
import { countryLabel } from "@/lib/shipping";
import { shipStatuses } from "@/lib/ship-check";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { pids } = (await req.json().catch(() => ({}))) as { pids?: unknown };
  const list = (Array.isArray(pids) ? pids : []).filter((p): p is string => typeof p === "string");
  const { country } = await getShipTo();
  return Response.json({ country, countryName: countryLabel(country), statuses: await shipStatuses(list, country) }, { headers: { "cache-control": "no-store" } });
}
