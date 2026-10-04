// A photo from the visitor's own chats.
import { prisma } from "@/lib/db";
import { getVisitorId } from "@/lib/chat-session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const visitorId = await getVisitorId();
  const img = visitorId ? await prisma.assistantImage.findFirst({ where: { id: (await params).id, visitorId } }) : null;
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(img.data), { headers: { "content-type": img.mime, "cache-control": "private, max-age=31536000, immutable" } });
}
