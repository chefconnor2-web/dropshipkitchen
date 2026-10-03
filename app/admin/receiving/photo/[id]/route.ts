import { prisma } from "@/lib/db";
import { readPhoto } from "@/lib/receiving/photos";

// Receiving photos stay behind admin auth (middleware covers /admin/*).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const photo = await prisma.receivingPhoto.findUnique({ where: { id } });
  if (!photo) return new Response("Not found", { status: 404 });
  try {
    const data = await readPhoto(photo.fileName);
    return new Response(new Uint8Array(data), {
      headers: { "Content-Type": photo.mimeType, "Cache-Control": "private, max-age=31536000, immutable" },
    });
  } catch {
    return new Response("Photo file missing", { status: 404 });
  }
}
