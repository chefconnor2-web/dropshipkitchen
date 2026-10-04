// Saves a shopper's print-on-demand design and adds the item to their cart. Multipart form:
// variantId, quantity, kind (photo | text), text, art (the image CJ prints), preview (the mock-up).
import { getOrCreateCartId, cartCount } from "@/lib/cart";
import { addVariantToCart } from "@/lib/cart-add";
import { createPersonalization, MAX_ART_BYTES, MAX_PREVIEW_BYTES } from "@/lib/personalize";
import { withCjPriority } from "@/lib/cj/lanes";

export const dynamic = "force-dynamic";

async function bytes(v: FormDataEntryValue | null, max: number): Promise<Uint8Array | null> {
  if (!v || typeof v === "string" || v.size > max) return null;
  return new Uint8Array(await v.arrayBuffer());
}

export function POST(req: Request) {
  // The shopper is waiting on this tap: CJ stock checks jump ahead of background work.
  return withCjPriority("urgent", () => save(req));
}

async function save(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ ok: false, message: "Couldn’t read the design. Please try again." }, { status: 400 });
  const art = await bytes(form.get("art"), MAX_ART_BYTES);
  const preview = await bytes(form.get("preview"), MAX_PREVIEW_BYTES);
  if (!art || !preview) return Response.json({ ok: false, message: "That photo is too large or missing. Try a smaller one." }, { status: 400 });
  const variantId = String(form.get("variantId") || "");
  const design = await createPersonalization({ variantId, kind: String(form.get("kind") || ""), text: String(form.get("text") ?? ""), art, preview });
  if (!design.ok) return Response.json(design, { status: 400 });
  const quantity = Math.max(1, Math.min(99, Number(form.get("quantity")) || 1));
  const r = await addVariantToCart(await getOrCreateCartId(), variantId, quantity, design.id);
  return Response.json({ ...r, cartCount: await cartCount() }, { status: r.ok ? 200 : 400 });
}
