// Kits: a whole project's parts list (one product per part) that the shopper can add to the cart in one go.
// Used by the assistant's add_kit tool and by the "Add entire kit" button in the chat.

import { prisma } from "@/lib/db";
import { openCjProduct } from "@/lib/open-product";
import { addVariantToCart } from "@/lib/cart-add";
import { stockStatus } from "@/lib/inventory";

export interface KitItem {
  part: string;
  pid: string;
  title: string;
  fromCents: number;
  quantity: number;
  /** Preferred option, in words ("20Ah", "black, EU plug"); matched against the product's options. */
  option?: string | undefined;
}

export interface Kit {
  id: string;
  name: string;
  items: KitItem[];
}

export interface KitLineResult {
  part: string;
  title: string;
  ok: boolean;
  message: string;
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);

/** Pick the option that best matches the hint, preferring options in stock. */
async function resolveVariant(productId: string, hint?: string) {
  const variants = await prisma.productVariant.findMany({
    where: { productId, enabled: true },
    orderBy: { position: "asc" },
    include: { offer: { include: { cjSupplierVariant: { select: { inventoryTotal: true } } } } },
  });
  const sellable = variants.filter((v) => v.offer);
  if (sellable.length <= 1) return sellable[0] ?? null;
  const want = words(hint ?? "");
  const score = (v: (typeof sellable)[number]) => {
    const have = new Set(words(v.name));
    const match = want.filter((w) => have.has(w)).length;
    const inStock = stockStatus(v.offer?.cjSupplierVariant.inventoryTotal) === "UNAVAILABLE" ? 0 : 1;
    return match * 10 + inStock;
  };
  return [...sellable].sort((a, b) => score(b) - score(a))[0];
}

/** Adds every kit item to the cart; one failure doesn't stop the rest. */
export async function addKitToCart(cartId: string, items: KitItem[], onItem: (done: number, total: number, r: KitLineResult) => void = () => {}) {
  const results: KitLineResult[] = [];
  for (const [i, item] of items.entries()) {
    let r: KitLineResult;
    try {
      const product = await openCjProduct(item.pid);
      const variant = product ? await resolveVariant(product.id, item.option) : null;
      if (!variant) r = { part: item.part, title: item.title, ok: false, message: "Not available any more." };
      else {
        const a = await addVariantToCart(cartId, variant.id, Math.max(1, Math.min(999, item.quantity || 1)));
        r = { part: item.part, title: item.title, ok: a.ok, message: a.ok ? `${item.quantity} × ${variant.name}` : a.message };
      }
    } catch {
      r = { part: item.part, title: item.title, ok: false, message: "Couldn't add this one. Try again in a moment." };
    }
    results.push(r);
    onItem(i + 1, items.length, r);
  }
  return results;
}
