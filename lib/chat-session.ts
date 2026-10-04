// Who owns which assistant chats. Shoppers don't log in: a long-lived random cookie (cs_vid) identifies
// the browser, and every chat and photo is tied to it. Only route handlers may create the cookie.
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

const VISITOR = "cs_vid";
const LEGACY_CHAT = "cs_chat";

/** The visitor id, or null when this browser has none yet (read-only; safe in server components). */
export async function getVisitorId(): Promise<string | null> {
  const v = (await cookies()).get(VISITOR)?.value;
  return v && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null;
}

/** The visitor id, creating the cookie when needed. Also adopts the one chat from before chat history existed. */
export async function ensureVisitorId(): Promise<string> {
  const jar = await cookies();
  let id = await getVisitorId();
  if (!id) {
    id = randomBytes(18).toString("base64url");
    jar.set(VISITOR, id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 400 });
  }
  const legacy = jar.get(LEGACY_CHAT)?.value;
  if (legacy) {
    await prisma.assistantChat.updateMany({ where: { id: legacy, visitorId: null }, data: { visitorId: id } });
    jar.delete(LEGACY_CHAT);
  }
  return id;
}

export async function findOwnChat(chatId: string | null | undefined, visitorId: string | null) {
  if (!chatId || !visitorId) return null;
  return prisma.assistantChat.findFirst({ where: { id: chatId, visitorId } });
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export async function listChats(visitorId: string | null): Promise<ChatSummary[]> {
  if (!visitorId) return [];
  const rows = await prisma.assistantChat.findMany({
    where: { visitorId, userTurns: { gt: 0 } },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: { id: true, title: true, updatedAt: true },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}
