// Chat endpoint for the sourcing assistant. GET ?chat=<id>: a transcript, plus the chat's active run (if any) and
// its last run. Sending a message is POST /api/assistant/runs (runs execute in the background; see lib/runs.ts).
import { cartCount } from "@/lib/cart";
import { assistantConfigured, type UiEntry } from "@/lib/assistant";
import { findOwnChat, getVisitorId } from "@/lib/chat-session";
import { getMemberId } from "@/lib/session";
import { aiAllowance } from "@/lib/membership";
import { planOffer } from "@/lib/plan-offer";
import { activeRunFor, lastRunFor } from "@/lib/runs";

export const dynamic = "force-dynamic";

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
    activeRun: chat ? await activeRunFor(chat.id) : null,
    lastRun: chat ? await lastRunFor(chat.id) : null,
    cartCount: await cartCount(),
  });
}

/** Clients from before runs existed: ask them to refresh. */
export async function POST() {
  return Response.json({ error: "Neon was updated. Refresh the page to keep chatting." }, { status: 409 });
}
