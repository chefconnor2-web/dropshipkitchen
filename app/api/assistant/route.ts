// Chat endpoint for the sourcing assistant. GET ?chat=<id>: a transcript. POST {message, chatId?, images?, voice?, editIndex?}:
// one turn, streamed as NDJSON; without chatId it starts a new chat and names it.
import { headers } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { getOrCreateCartId, cartCount } from "@/lib/cart";
import { AssistantLimitError, assistantConfigured, chatTurn, generateTitle, type UiEntry } from "@/lib/assistant";
import { ensureVisitorId, findOwnChat, getVisitorId, ownedBy } from "@/lib/chat-session";
import { getMemberId } from "@/lib/session";
import { aiAllowance, limitMessage, recordAiUse } from "@/lib/membership";
import { planOffer } from "@/lib/plan-offer";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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

export async function GET(req: Request) {
  const chatId = new URL(req.url).searchParams.get("chat");
  const chat = await findOwnChat(chatId);
  const allowance = await aiAllowance({ customerId: await getMemberId(), visitorId: await getVisitorId() });
  return Response.json({
    configured: assistantConfigured(),
    allowance: { remaining: allowance.remaining, limit: allowance.limit, subscriber: allowance.subscriber },
    plans: allowance.subscriber ? null : await planOffer(),
    chat: chat ? { id: chat.id, title: chat.title } : null,
    entries: chat ? (JSON.parse(chat.uiJson) as UiEntry[]) : [],
    cartCount: await cartCount(),
  });
}

export async function POST(req: Request) {
  if (!assistantConfigured()) return Response.json({ error: "The assistant isn't switched on yet." }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { message?: unknown; chatId?: unknown; images?: unknown; voice?: unknown; editIndex?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const imageIds = (Array.isArray(body.images) ? body.images : []).filter((x): x is string => typeof x === "string").slice(0, 4);
  if (!message && !imageIds.length) return Response.json({ error: "Type a message first." }, { status: 400 });
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (!allow(ip)) return Response.json({ error: "You've sent a lot of messages. Please wait a bit and try again." }, { status: 429 });

  const visitorId = await ensureVisitorId();
  // Subscribers get a monthly allowance (Lite: an AI cost budget; full: by spend tier; or the merchant's own number);
  // everyone else a free trial.
  const memberId = await getMemberId();
  const allowance = await aiAllowance({ customerId: memberId, visitorId });
  if (allowance.remaining <= 0) {
    const offer = await planOffer();
    const prices = { full: formatMoney(offer.full.priceCents), lite: offer.lite.enabled ? formatMoney(offer.lite.priceCents) : null };
    return Response.json(
      { error: limitMessage(allowance, prices), limit: { subscriber: allowance.subscriber, signedIn: !!memberId, plan: allowance.plan }, plans: allowance.plan === "full" ? null : offer },
      { status: 402 },
    );
  }
  let chat = typeof body.chatId === "string" ? await findOwnChat(body.chatId) : null;
  if (typeof body.chatId === "string" && !chat) return Response.json({ error: "That chat isn't available. Start a new one." }, { status: 404 });
  const isNew = !chat;
  chat ??= await prisma.assistantChat.create({ data: { visitorId, customerId: memberId, title: message.replace(/\s+/g, " ").slice(0, 48) || "Photo search" } });
  const images = imageIds.length
    ? await prisma.assistantImage.findMany({ where: { id: { in: imageIds }, ...ownedBy(memberId, visitorId) }, select: { id: true, mime: true } })
    : [];
  if (images.length) await prisma.assistantImage.updateMany({ where: { id: { in: images.map((i) => i.id) } }, data: { chatId: chat.id } });
  const editIndex = typeof body.editIndex === "number" && Number.isInteger(body.editIndex) ? body.editIndex : undefined;
  const cartId = await getOrCreateCartId();
  const chatRow = chat;

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
      send({ type: "chat", id: chatRow.id, title: chatRow.title, isNew });
      // Name new chats (and chats whose first message was edited) while the answer is being written.
      const titling =
        isNew || editIndex === 0
          ? generateTitle(message, images.length > 0).then(async (title) => {
              await prisma.assistantChat.update({ where: { id: chatRow.id }, data: { title } });
              send({ type: "title", id: chatRow.id, title });
            })
          : null;
      try {
        const { entry, costMicros } = await chatTurn(chatRow.id, cartId, { text: message, images, voice: body.voice === true, editIndex }, (ev) => send(ev));
        await recordAiUse({ customerId: memberId, visitorId, chatId: chatRow.id, costMicros });
        await Promise.race([titling, new Promise((r) => setTimeout(r, 4000))]);
        const after = await aiAllowance({ customerId: memberId, visitorId });
        send({ type: "done", entry, cartCount: await cartCount(), allowance: { remaining: after.remaining, limit: after.limit, subscriber: after.subscriber } });
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
