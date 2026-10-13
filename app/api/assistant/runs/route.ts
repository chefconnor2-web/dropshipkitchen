// POST /api/assistant/runs: send a message. Answers 202 as soon as the run is recorded (before Neon starts
// thinking); the reply streams from GET /api/assistant/runs/:id/events. See docs/frontier-port/CONTRACTS.md §5.
import { after } from "next/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { getOrCreateCartId } from "@/lib/cart";
import { assistantConfigured } from "@/lib/assistant";
import { ensureVisitorId, findOwnChat, ownedBy } from "@/lib/chat-session";
import { getMemberId } from "@/lib/session";
import { aiAllowance, limitMessage } from "@/lib/membership";
import { planOffer } from "@/lib/plan-offer";
import { formatMoney } from "@/lib/money";
import { cleanDocs } from "@/lib/docs-shared";
import { acceptRun, allowTurn, crossOrigin, validRequestId } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (crossOrigin(req)) return Response.json({ error: "Not allowed." }, { status: 403 });
  if (!assistantConfigured()) return Response.json({ error: "The assistant isn't switched on yet." }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as {
    clientRequestId?: unknown;
    message?: unknown;
    chatId?: unknown;
    images?: unknown;
    voice?: unknown;
    editIndex?: unknown;
    docs?: unknown;
  };
  if (!validRequestId(body.clientRequestId)) return Response.json({ error: "Refresh the page and try again." }, { status: 400 });
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const imageIds = (Array.isArray(body.images) ? body.images : []).filter((x): x is string => typeof x === "string").slice(0, 4);
  const { docs, error: docError } = cleanDocs(body.docs);
  if (docError) return Response.json({ error: docError }, { status: 400 });
  const editIndex = typeof body.editIndex === "number" && Number.isInteger(body.editIndex) && body.editIndex >= 0 ? body.editIndex : undefined;
  if (!message && !imageIds.length && !docs.length && editIndex === undefined) return Response.json({ error: "Type a message first." }, { status: 400 });

  const visitorId = await ensureVisitorId();
  const memberId = await getMemberId();
  let chat = typeof body.chatId === "string" ? await findOwnChat(body.chatId) : null;
  if (typeof body.chatId === "string" && !chat) return Response.json({ error: "That chat isn't available. Start a new one." }, { status: 404 });

  // A retry of a send that already landed (even one that started a new chat): the same run, nothing new
  // started, and not counted again.
  const dup = await prisma.assistantRun.findFirst({ where: { clientRequestId: body.clientRequestId, ...(chat ? { chatId: chat.id } : {}) } });
  const dupChat = dup ? (chat ?? (await findOwnChat(dup.chatId))) : null;
  if (dup && dupChat) {
    const r = await acceptRun({ chat: dupChat, isNew: false, clientRequestId: body.clientRequestId, text: message, images: [], docs: [], voice: false, customerId: memberId, visitorId, cartId: "" });
    if (r.ok) return Response.json(r.accepted, { status: 200 });
  }

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (!allowTurn(ip)) return Response.json({ error: "You've sent a lot of messages. Please wait a bit and try again." }, { status: 429 });
  // Subscribers get a monthly allowance; everyone else a free trial.
  const allowance = await aiAllowance({ customerId: memberId, visitorId });
  if (allowance.remaining <= 0) {
    const offer = await planOffer();
    const prices = { full: formatMoney(offer.full.priceCents), lite: offer.lite.enabled ? formatMoney(offer.lite.priceCents) : null };
    return Response.json(
      { error: limitMessage(allowance, prices), limit: { subscriber: allowance.subscriber, signedIn: !!memberId, plan: allowance.plan }, plans: allowance.plan === "full" ? null : offer },
      { status: 402 },
    );
  }

  const isNew = !chat;
  chat ??= await prisma.assistantChat.create({
    data: { visitorId, customerId: memberId, title: message.replace(/\s+/g, " ").slice(0, 48) || docs[0]?.name.slice(0, 48) || "Photo search" },
  });
  const images = imageIds.length
    ? await prisma.assistantImage.findMany({ where: { id: { in: imageIds }, ...ownedBy(memberId, visitorId) }, select: { id: true, mime: true } })
    : [];
  if (images.length) await prisma.assistantImage.updateMany({ where: { id: { in: images.map((i) => i.id) } }, data: { chatId: chat.id } });
  const cartId = await getOrCreateCartId();

  const r = await acceptRun({
    chat,
    isNew,
    clientRequestId: body.clientRequestId,
    text: message,
    images,
    docs,
    voice: body.voice === true,
    editIndex,
    customerId: memberId,
    visitorId,
    cartId,
  });
  if (!r.ok) return Response.json(r.body, { status: r.status });
  // The run executes after this response is sent. Request APIs (the cart and ship-to cookies) stay readable
  // inside after() in a route handler; anything that sets cookies happened above.
  if (r.start) {
    const start = r.start;
    after(() => start());
  }
  return Response.json(r.accepted, { status: r.accepted.duplicate ? 200 : 202 });
}
