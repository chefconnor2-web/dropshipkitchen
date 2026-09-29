"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { clearCartCookie, getCartId } from "@/lib/cart";

export async function clearCart() {
  const id = await getCartId();
  if (id) await prisma.cart.deleteMany({ where: { id } });
  await clearCartCookie();
  revalidatePath("/", "layout");
}
