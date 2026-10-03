// The exact HTML of one logged email, for preview. Under /admin, so the admin login protects it.
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const log = await prisma.emailLog.findUnique({ where: { id: (await params).id } });
  if (!log) return new Response("Not found", { status: 404 });
  return new Response(log.html, {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'", "cache-control": "no-store" },
  });
}
