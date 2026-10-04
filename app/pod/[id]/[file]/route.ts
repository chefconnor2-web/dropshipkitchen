// A shopper's print-on-demand design: /pod/<id>/art (what CJ prints) and /pod/<id>/preview (the mock-up).
// Public on purpose so CJ can download it; the id is an unguessable cuid.
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  if (file !== "art" && file !== "preview") return new Response("Not found", { status: 404 });
  const p =
    file === "art"
      ? await prisma.personalization.findUnique({ where: { id }, select: { art: true, artMime: true } }).then((r) => r && { data: r.art, mime: r.artMime })
      : await prisma.personalization.findUnique({ where: { id }, select: { preview: true, previewMime: true } }).then((r) => r && { data: r.preview, mime: r.previewMime });
  if (!p) return new Response("Not found", { status: 404 });
  const { data, mime } = p;
  return new Response(Buffer.from(data), {
    headers: { "content-type": mime, "cache-control": "public, max-age=31536000, immutable", "x-robots-tag": "noindex" },
  });
}
