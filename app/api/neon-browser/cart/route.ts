import { prisma } from "@/lib/db";
import { neonKeyOk, ownerWho } from "@/lib/neon-browser";
import { acting } from "@/lib/acting";
import { catalogTool } from "@/lib/assistant";
import { cartView } from "@/lib/mcp-server";
import { getCartId, getOrCreateCartId } from "@/lib/cart";
import { openCjProduct } from "@/lib/open-product";
import { stockStatus } from "@/lib/inventory";
import { publishableKey, isEmbedded } from "@/lib/stripe-customer";
import { stripe } from "@/lib/stripe";
import { config } from "@/lib/config";

// Neon Browser → Chit: shop the CJ cart inside the chat. get / add / update, and an embedded checkout that
// returns Stripe's client secret. Key-guarded, owner-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type CartLine = { lineId: string; product: string; option?: string; quantity: number; lineTotal: string };
type Cart = { lines: CartLine[]; subtotal: string | null; shipping?: string; ownerPrice?: boolean };

function normalize(summary: unknown): Cart {
  const s = (summary ?? {}) as { items?: unknown; subtotal?: string; shipping?: string; owner_price?: string };
  const items = Array.isArray(s.items) ? (s.items as Array<Record<string, unknown>>) : [];
  return {
    lines: items.map((i) => ({ lineId: String(i.line_id), product: String(i.product), option: i.option ? String(i.option) : undefined, quantity: Number(i.quantity), lineTotal: String(i.line_total) })),
    subtotal: s.subtotal ?? null,
    shipping: s.shipping,
    ownerPrice: !!s.owner_price,
  };
}

async function viewFor(cartId: string | null): Promise<Cart> {
  if (!cartId) return { lines: [], subtotal: null };
  return normalize((await cartView(cartId)).summary);
}

/** Pick a buyable variant for a pid: the first in-stock option, else the first enabled one. */
async function variantForPid(pid: string): Promise<string | null> {
  const product = await openCjProduct(pid);
  if (!product) return null;
  const vs = await prisma.productVariant.findMany({
    where: { productId: product.id, enabled: true },
    orderBy: { position: "asc" },
    select: { id: true, offer: { select: { cjSupplierVariant: { select: { inventoryTotal: true } } } } },
  });
  const inStock = vs.find((v) => v.offer && stockStatus(v.offer.cjSupplierVariant.inventoryTotal) !== "UNAVAILABLE");
  return (inStock ?? vs[0])?.id ?? null;
}

export async function POST(req: Request) {
  if (!neonKeyOk(req.headers.get("x-neon-key"))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const who = await ownerWho();
  if (!who) return Response.json({ error: "No owner account is configured on Chit." }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send JSON with an action." }, { status: 400 });
  }
  const action = String(body.action ?? "");

  return acting.run({ customerId: who.customerId }, async () => {
    if (action === "get") {
      return Response.json({ cart: await viewFor(await getCartId()) });
    }

    if (action === "add") {
      let variantId = typeof body.variantId === "string" ? body.variantId : "";
      const pid = typeof body.pid === "string" ? body.pid : "";
      if (!variantId && pid) variantId = (await variantForPid(pid)) ?? "";
      if (!variantId) return Response.json({ error: "That product has no option in stock." }, { status: 400 });
      const quantity = Math.max(1, Math.min(999, Number(body.quantity) || 1));
      const cartId = await getOrCreateCartId();
      const r = await catalogTool("add_to_cart", { variant_id: variantId, quantity }, cartId);
      if (r.isError) return Response.json({ error: String(r.content) }, { status: 400 });
      await prisma.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } }).catch(() => {});
      return Response.json({ cart: await viewFor(cartId) });
    }

    if (action === "update") {
      const lineId = String(body.lineId ?? "");
      const quantity = Math.max(0, Math.min(999, Number(body.quantity)));
      const cartId = await getCartId();
      const line = cartId ? await prisma.cartItem.findFirst({ where: { id: lineId, cartId } }) : null;
      if (!cartId || !line) return Response.json({ error: "That line isn't in the cart." }, { status: 404 });
      if (quantity === 0) await prisma.cartItem.delete({ where: { id: line.id } });
      else await prisma.cartItem.update({ where: { id: line.id }, data: { quantity } });
      await prisma.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } }).catch(() => {});
      return Response.json({ cart: await viewFor(cartId) });
    }

    return Response.json({ error: "Unknown action." }, { status: 400 });
  });
}
