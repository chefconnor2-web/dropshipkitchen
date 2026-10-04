// Rename (PATCH {title}) or delete one of the shopper's own chats.
import { prisma } from "@/lib/db";
import { findOwnChat } from "@/lib/chat-session";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const chat = await findOwnChat((await params).id);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
  const { title } = (await req.json().catch(() => ({}))) as { title?: unknown };
  const t = typeof title === "string" ? title.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  if (!t) return Response.json({ error: "Give the chat a name." }, { status: 400 });
  // Renaming shouldn't move the chat to the top of the list, so keep updatedAt.
  await prisma.assistantChat.update({ where: { id: chat.id }, data: { title: t, updatedAt: chat.updatedAt } });
  return Response.json({ ok: true, title: t });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const chat = await findOwnChat((await params).id);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
  await prisma.assistantImage.deleteMany({ where: { chatId: chat.id } });
  await prisma.assistantChat.delete({ where: { id: chat.id } });
  return Response.json({ ok: true });
}
