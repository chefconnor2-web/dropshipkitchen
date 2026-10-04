// "Add" on a product card in the chat. {pid}: single-option products go straight in; otherwise the
// options come back for an inline picker. {variantId}: adds that exact option.
import { prisma } from "@/lib/db";
import { getOrCreateCartId, cartCount } from "@/lib/cart";
import { addVariantToCart } from "@/lib/cart-add";
import { openCjProduct } from "@/lib/open-product";
import { stockLabel, stockStatus } from "@/lib/inventory";
import { withCjPriority } from "@/lib/cj/lanes";
import { chatDesigner } from "@/lib/personalize";

export const dynamic = "force-dynamic";

export function POST(req: Request) {
  // A shopper is waiting on this tap: its CJ calls go ahead of background imports.
  return withCjPriority("urgent", () => add(req));
}

async function add(req: Request) {
  const { pid, variantId, quantity } = (await req.json().catch(() => ({}))) as { pid?: string; variantId?: string; quantity?: number };
  const qty = Math.max(1, Math.min(999, Number(quantity) || 1));

  if (variantId) {
    const v = await prisma.productVariant.findUnique({ where: { id: String(variantId) }, select: { productId: true } });
    const designer = v && (await chatDesigner(v.productId));
    if (designer) return Response.json({ ok: false, personalize: designer });
    const r = await addVariantToCart(await getOrCreateCartId(), String(variantId), qty);
    return Response.json({ ...r, cartCount: await cartCount() });
  }

  const product = await openCjProduct(String(pid ?? ""));
  if (!product) return Response.json({ ok: false, message: "Sorry, that product isn't available." }, { status: 404 });
  // Made with the shopper's own photo or text: the chat opens its designer instead of adding.
  const designer = await chatDesigner(product.id);
  if (designer) return Response.json({ ok: false, personalize: designer });
  const variants = await prisma.productVariant.findMany({
    where: { productId: product.id, enabled: true },
    orderBy: { position: "asc" },
    include: { offer: { include: { cjSupplierVariant: { select: { inventoryTotal: true } } } } },
  });
  const sellable = variants.filter((v) => v.offer);
  if (!sellable.length) return Response.json({ ok: false, message: "Sorry, that product isn't available." }, { status: 404 });
  if (sellable.length === 1) {
    const r = await addVariantToCart(await getOrCreateCartId(), sellable[0].id, qty);
    return Response.json({ ...r, cartCount: await cartCount() });
  }
  return Response.json({
    ok: false,
    choose: true,
    productUrl: `/products/${product.slug}`,
    options: sellable.slice(0, 60).map((v) => {
      const s = stockStatus(v.offer?.cjSupplierVariant.inventoryTotal);
      return { id: v.id, name: v.name, priceCents: v.priceCents, available: s !== "UNAVAILABLE", stock: stockLabel(s) };
    }),
  });
}
