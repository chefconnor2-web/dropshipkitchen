// Chat endpoint for the sourcing assistant. GET: the current transcript. POST {message}: one turn. DELETE: new chat.
import { cookies, headers } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { getOrCreateCartId, cartCount } from "@/lib/cart";
import { AssistantLimitError, assistantConfigured, chatTurn, type UiEntry } from "@/lib/assistant";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COOKIE = "cs_chat";
// Cheap per-IP brake on spend: 30 turns an hour.
const hits = new Map<string, number[]>();
function allow(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= 30) return false;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value!);
  return true;
}

async function currentChat(create: boolean) {
  const jar = await cookies();
  const id = jar.get(COOKIE)?.value;
  const found = id ? await prisma.assistantChat.findUnique({ where: { id } }) : null;
  if (found || !create) return found;
  const chat = await prisma.assistantChat.create({ data: {} });
  jar.set(COOKIE, chat.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return chat;
}

export async function GET() {
  const chat = await currentChat(false);
  return Response.json({ configured: assistantConfigured(), entries: chat ? (JSON.parse(chat.uiJson) as UiEntry[]) : [], cartCount: await cartCount() });
}

export async function DELETE() {
  (await cookies()).delete(COOKIE);
  return Response.json({ ok: true });
}

export async function POST(req: Request) {
  if (!assistantConfigured()) return Response.json({ error: "The assistant isn't switched on yet." }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "Type a message first." }, { status: 400 });
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (!allow(ip)) return Response.json({ error: "You've sent a lot of messages. Please wait a bit and try again." }, { status: 429 });

  const chat = (await currentChat(true))!;
  const cartId = await getOrCreateCartId();

  // NDJSON stream: progress notes while tools run (keeps the connection alive on slow turns), then the result.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // If the shopper's connection drops, keep going: the turn still finishes and is saved to the chat.
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
        const entry = await chatTurn(chat.id, cartId, message, (ev) => send(ev));
        send({ type: "done", entry, cartCount: await cartCount() });
      } catch (e) {
        let error = "Something went wrong. Please try again.";
        if (e instanceof AssistantLimitError) error = e.message;
        else if (e instanceof Anthropic.RateLimitError) error = "The assistant is busy. Try again in a minute.";
        else if (e instanceof Anthropic.AuthenticationError) {
          console.error("[assistant] bad ANTHROPIC_API_KEY");
          error = "The assistant isn't set up correctly.";
        } else console.error("[assistant]", e);
        send({ type: "error", error });
      } finally {
        clearInterval(ping);
        if (open)
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
