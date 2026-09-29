import { prisma } from "@/lib/db";
import { proxyImage } from "@/lib/media";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const img = await prisma.productImage.findUnique({ where: { id: (await params).id } });
  return proxyImage(img?.sourceUrl);
}
