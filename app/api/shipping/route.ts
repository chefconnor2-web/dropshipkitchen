// Shipping for one product option to the shopper's saved destination. ?mode=fast never waits on CJ;
// ?mode=live returns CJ's fresh price. The product page shows the fast answer, then the live one.
import { getShipTo } from "@/lib/cart";
import { withCjPriority } from "@/lib/cj/lanes";
import { fastShipView, liveShipView } from "@/lib/ship-view";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const variantId = url.searchParams.get("variantId") ?? "";
  const quantity = Math.max(1, Math.min(99, Number(url.searchParams.get("quantity")) || 1));
  const { country, zip } = await getShipTo();
  const body =
    url.searchParams.get("mode") === "live"
      ? await withCjPriority("urgent", () => liveShipView(variantId, quantity, country, zip))
      : await fastShipView(variantId, quantity, country, zip);
  return Response.json({ ...body, country, zip }, { headers: { "cache-control": "no-store" } });
}
