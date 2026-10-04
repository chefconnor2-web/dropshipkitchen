// The cart's shipping quote, fetched ahead of time so the cart page doesn't wait on CJ.
import { cartBoxPicks, cartShipItems, getShipTo, loadCart } from "@/lib/cart";
import { withCjPriority } from "@/lib/cj/lanes";
import { quoteCart } from "@/lib/shipping";
import { processSingleton } from "@/lib/singleton";

const SETTLE_MS = 1500;
const pending = processSingleton("cart-quote-pending", () => new Map<string, ReturnType<typeof setTimeout>>());

/**
 * Starts this cart's shipping quote in the background once the cart stops changing (a kit adds several
 * items in a row). The quote is cached, and the cart page joins it if it's still running. Never throws.
 */
export async function prewarmCartQuote(cartId: string) {
  // Cookies can only be read during the request, so read the destination now and quote afterwards.
  const shipTo = await getShipTo().catch(() => null);
  if (!shipTo) return;
  clearTimeout(pending.get(cartId));
  pending.set(
    cartId,
    setTimeout(() => {
      pending.delete(cartId);
      void withCjPriority("background", async () => {
        const cart = await loadCart(cartId);
        if (!cart || (!cart.items.length && !cart.boxes.length)) return;
        await quoteCart(cartShipItems(cart, await cartBoxPicks(cart)), shipTo.country, shipTo.zip);
      }).catch(() => null);
    }, SETTLE_MS),
  );
}
