import { notFound, redirect } from "next/navigation";
import { openCjProduct } from "@/lib/open-product";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/** Opens a search result as a real, buyable product page (see lib/open-product.ts). */
export default async function OpenSearchResult({ params }: { params: Promise<{ pid: string }> }) {
  const product = await openCjProduct(decodeURIComponent((await params).pid));
  if (!product) notFound();
  redirect(`/products/${product.slug}`);
}
