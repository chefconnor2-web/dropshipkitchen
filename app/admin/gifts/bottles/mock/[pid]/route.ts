// The bottle finder's mock-up: CJ's product photo with the chosen logo printed on the bottle.

import { analyseBottle, bottleMockup } from "@/lib/bottle-mockup";
import { searchImage } from "@/lib/catalog-search";
import { GIFT_DESIGNS, type GiftDesign } from "@/lib/gifts";

export async function GET(req: Request, { params }: { params: Promise<{ pid: string }> }) {
  const { pid } = await params;
  const d = new URL(req.url).searchParams.get("design") ?? "";
  const design = GIFT_DESIGNS[(d in GIFT_DESIGNS ? d : "mascot") as GiftDesign];
  let jpeg = await bottleMockup(pid, design.file);
  // After a restart the measurements are gone; measure again from the photo this server last listed.
  if (!jpeg) {
    const url = searchImage(pid);
    if (url && (await analyseBottle(pid, url))) jpeg = await bottleMockup(pid, design.file);
  }
  if (!jpeg) return new Response("No mock-up for this product", { status: 404 });
  return new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=1800" } });
}
