// Who owns which assistant chats. A signed-in shopper owns chats by customer id (on any device); a
// signed-out browser owns its chats by a long-lived random cookie (cs_vid). A chat with an owner never
// opens by visitor id alone, so signing out (which also replaces cs_vid) leaves nothing behind.
// Only route handlers may create the cookie.
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getMemberId } from "@/lib/session";

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

/** Prisma filter for the chats (or chat photos) this shopper may see: theirs by account, else this browser's unowned ones. */
export function ownedBy(customerId: string | null, visitorId: string | null): Prisma.AssistantChatWhereInput & Prisma.AssistantImageWhereInput {
  if (customerId) return { customerId };
  if (visitorId) return { customerId: null, visitorId };
  return { id: "\u0000never" };
}

/** The current shopper's ownership filter. */
export async function currentOwner() {
  const [customerId, visitorId] = await Promise.all([getMemberId(), getVisitorId()]);
  return { customerId, visitorId, where: ownedBy(customerId, visitorId) };
}

export async function findOwnChat(chatId: string | null | undefined) {
  if (!chatId) return null;
  const { where } = await currentOwner();
  return prisma.assistantChat.findFirst({ where: { id: chatId, ...where } });
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export async function listChats(): Promise<ChatSummary[]> {
  const { customerId, visitorId, where } = await currentOwner();
  if (!customerId && !visitorId) return [];
  const rows = await prisma.assistantChat.findMany({
    where: { ...where, userTurns: { gt: 0 } },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: { id: true, title: true, updatedAt: true },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}
