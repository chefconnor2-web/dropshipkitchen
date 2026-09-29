import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

const COOKIE = "cs_cart";

export async function getCartId(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}

/** Only callable from server actions / route handlers (sets a cookie). */
export async function getOrCreateCartId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing && (await prisma.cart.findUnique({ where: { id: existing } }))) return existing;
  const cart = await prisma.cart.create({ data: {} });
  jar.set(COOKIE, cart.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return cart.id;
}

export async function clearCartCookie() {
  (await cookies()).delete(COOKIE);
}

/** Cart contents including the internal supplier mapping — server-side only. */
export async function loadCart(cartId: string | null) {
  if (!cartId) return null;
  return prisma.cart.findUnique({
    where: { id: cartId },
    include: {
      items: {
        orderBy: { id: "asc" },
        include: {
          variant: {
            include: {
              product: { include: { images: { orderBy: { position: "asc" }, take: 1 } } },
              offer: { include: { cjSupplierVariant: true } },
            },
          },
        },
      },
    },
  });
}

export async function cartCount(): Promise<number> {
  const id = await getCartId();
  if (!id) return 0;
  const agg = await prisma.cartItem.aggregate({ where: { cartId: id }, _sum: { quantity: true } });
  return agg._sum.quantity ?? 0;
}
