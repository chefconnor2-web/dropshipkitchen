import { prisma } from "@/lib/db";
import { proxyImage } from "@/lib/media";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const v = await prisma.productVariant.findUnique({ where: { id: (await params).id }, select: { imageUrl: true } });
  return proxyImage(v?.imageUrl);
}
