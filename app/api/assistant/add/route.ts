// One-tap "Add" on a product card in the chat. Single-option products go straight in; others open the product page.
import { prisma } from "@/lib/db";
import { getOrCreateCartId, cartCount } from "@/lib/cart";
import { addVariantToCart } from "@/lib/cart-add";
import { openCjProduct } from "@/lib/open-product";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { pid } = (await req.json().catch(() => ({}))) as { pid?: string };
  const product = await openCjProduct(String(pid ?? ""));
  if (!product) return Response.json({ ok: false, message: "Sorry, that product isn't available." }, { status: 404 });
  const variants = await prisma.productVariant.findMany({ where: { productId: product.id, enabled: true }, include: { offer: true } });
  const sellable = variants.filter((v) => v.offer);
  if (sellable.length !== 1) return Response.json({ ok: false, chooseAt: `/products/${product.slug}` });
  const r = await addVariantToCart(await getOrCreateCartId(), sellable[0].id, 1);
  return Response.json({ ...r, cartCount: await cartCount() });
}
