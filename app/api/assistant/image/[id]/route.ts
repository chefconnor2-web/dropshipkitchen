// A photo from the shopper's own chats (their account's, or this browser's when signed out).
import { prisma } from "@/lib/db";
import { currentOwner } from "@/lib/chat-session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { where } = await currentOwner();
  const img = await prisma.assistantImage.findFirst({ where: { id: (await params).id, ...where } });
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(img.data), { headers: { "content-type": img.mime, "cache-control": "private, max-age=31536000, immutable" } });
}
