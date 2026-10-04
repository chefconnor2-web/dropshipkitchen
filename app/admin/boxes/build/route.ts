// Streams an AI box build (NDJSON). Under /admin, so the admin login protects it.
import { buildBoxWithAI, type BuilderEvent } from "@/lib/box-builder";
import { assistantConfigured } from "@/lib/assistant";
import { dollarsToCents } from "@/lib/money";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: Request) {
  if (!assistantConfigured()) return Response.json({ error: "Set ANTHROPIC_API_KEY to design boxes with AI." }, { status: 503 });
  const b = (await req.json().catch(() => ({}))) as { brief?: string; price?: string; items?: number; guaranteed?: string };
  const brief = String(b.brief ?? "").trim().slice(0, 600);
  const priceCents = dollarsToCents(String(b.price ?? ""));
  const itemCount = Math.round(Number(b.items));
  const guaranteedValueCents = b.guaranteed ? dollarsToCents(String(b.guaranteed)) : null;
  if (!brief || !priceCents || priceCents < 1000 || !(itemCount >= 2 && itemCount <= 10))
    return Response.json({ error: "Give a brief, a price of at least $10 and 2-10 items." }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (o: BuilderEvent | { type: "ping" }) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        } catch {
          open = false;
        }
      };
      const ping = setInterval(() => send({ type: "ping" }), 5000);
      try {
        await buildBoxWithAI({ brief, priceCents, itemCount, ...(guaranteedValueCents ? { guaranteedValueCents } : {}) }, send);
      } catch (e) {
        console.error("[box-builder]", e);
        send({ type: "error", error: e instanceof Error ? e.message : "The build failed." });
      } finally {
        clearInterval(ping);
        if (open)
          try {
            controller.close();
          } catch {
            /* closed */
          }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
