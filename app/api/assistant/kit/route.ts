// "Add entire kit" from a kit card in the chat. Only kits this shopper's chat produced can be added.
// Streams NDJSON: {type:"item", done, total, result} per line item, then {type:"done", results, cartCount}.
import { cartCount, getOrCreateCartId } from "@/lib/cart";
import { addKitToCart } from "@/lib/kit";
import type { UiEntry } from "@/lib/assistant";
import { findOwnChat } from "@/lib/chat-session";
import { withCjPriority } from "@/lib/cj/lanes";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const { kitId, chatId } = (await req.json().catch(() => ({}))) as { kitId?: string; chatId?: string };
  const chat = await findOwnChat(chatId);
  const kit = chat
    ? (JSON.parse(chat.uiJson) as UiEntry[]).flatMap((e) => (e.role === "assistant" && e.kit ? [e.kit] : [])).find((k) => k.id === kitId)
    : undefined;
  if (!kit) return Response.json({ error: "That kit isn't available any more. Ask the assistant to rebuild it." }, { status: 404 });
  const cartId = await getOrCreateCartId();

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (o: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        } catch {
          open = false;
        }
      };
      const ping = setInterval(() => send({ type: "ping" }), 5000);
      try {
        const results = await withCjPriority("urgent", () => addKitToCart(cartId, kit.items, (done, total, result) => send({ type: "item", done, total, result })));
        send({ type: "done", results, cartCount: await cartCount() });
      } catch (e) {
        console.error("[kit]", e);
        send({ type: "error", error: "Something went wrong adding the kit." });
      } finally {
        clearInterval(ping);
        if (open)
          try {
            controller.close();
          } catch {
            /* closed by the client */
          }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
