import { proxyImage } from "@/lib/media";
import { searchImage } from "@/lib/catalog-search";

export async function GET(_req: Request, { params }: { params: Promise<{ pid: string }> }) {
  return proxyImage(searchImage((await params).pid));
}
