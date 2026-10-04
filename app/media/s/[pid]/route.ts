import { proxyImage } from "@/lib/media";
import { searchImage } from "@/lib/catalog-search";
import { prisma } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ pid: string }> }) {
  const pid = (await params).pid;
  // Search results are cached in memory; after a restart (or for imported products) fall back to the catalog.
  let src = searchImage(pid);
  if (!src) {
    const sp = await prisma.cjSupplierProduct.findUnique({
      where: { cjProductId: pid },
      select: { cjImages: true, products: { select: { images: { orderBy: { position: "asc" }, take: 1, select: { sourceUrl: true } } }, take: 1 } },
    });
    src = sp?.products[0]?.images[0]?.sourceUrl ?? (JSON.parse(sp?.cjImages || "[]") as string[])[0];
  }
  return proxyImage(src);
}
