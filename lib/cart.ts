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

// ---- ship-to: where the shopper wants it sent and which tier they picked, for the shipping quote ----
const SHIP_COOKIE = "cs_ship";

export interface ShipTo {
  country: string;
  zip: string;
  tier: "standard" | "express";
}

export async function getShipTo(): Promise<ShipTo> {
  const fallback: ShipTo = { country: "CA", zip: "", tier: "standard" };
  try {
    const v = JSON.parse((await cookies()).get(SHIP_COOKIE)?.value ?? "null") as Partial<ShipTo> | null;
    if (!v) return fallback;
    return {
      country: typeof v.country === "string" && /^[A-Z]{2}$/.test(v.country) ? v.country : "CA",
      zip: typeof v.zip === "string" ? v.zip.slice(0, 12) : "",
      tier: v.tier === "express" ? "express" : "standard",
    };
  } catch {
    return fallback;
  }
}

/** Only callable from server actions / route handlers (sets a cookie). */
export async function setShipTo(v: ShipTo) {
  (await cookies()).set(SHIP_COOKIE, JSON.stringify(v), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
}

type LoadedCart = NonNullable<Awaited<ReturnType<typeof loadCart>>>;

/** The cart's sellable lines as exact CJ VIDs, for a freight quote. */
export function cartShipItems(cart: LoadedCart | null) {
  return (cart?.items ?? [])
    .filter((i) => i.variant.enabled && i.variant.product.status === "PUBLISHED" && i.variant.offer)
    .map((i) => ({
      vid: i.variant.offer!.cjSupplierVariant.cjVariantId,
      quantity: i.quantity,
      inventoryJson: i.variant.offer!.cjSupplierVariant.inventoryJson,
      weightGrams: i.variant.offer!.cjSupplierVariant.weightGrams,
    }));
}
