import { prisma } from "@/lib/db";
import { neonKeyOk, ownerWho } from "@/lib/neon-browser";
import { openCjProduct } from "@/lib/open-product";
import { stockStatus } from "@/lib/inventory";
import { config } from "@/lib/config";

// Neon Browser → Chit: one product's detail for the in-chat product view — title, description, photos, and the
// buyable options (variant_id, price, stock). Key-guarded, owner-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 45;

export async function POST(req: Request) {
  if (!neonKeyOk(req.headers.get("x-neon-key"))) return Response.json({ error: "Not allowed." }, { status: 401 });
  if (!(await ownerWho())) return Response.json({ error: "No owner account is configured on Chit." }, { status: 500 });

  let body: { pid?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Send JSON with a pid." }, { status: 400 });
  }
  const pid = String(body.pid ?? "");
  if (!pid) return Response.json({ error: "pid is required." }, { status: 400 });

  const product = await openCjProduct(pid);
  if (!product) return Response.json({ error: "That product isn't available." }, { status: 404 });

  const [images, variants] = await Promise.all([
    prisma.productImage.findMany({ where: { productId: product.id }, orderBy: { position: "asc" }, select: { id: true } }),
    prisma.productVariant.findMany({
      where: { productId: product.id, enabled: true },
      orderBy: { position: "asc" },
      take: 40,
      select: { id: true, name: true, priceCents: true, imageUrl: true, offer: { select: { cjSupplierVariant: { select: { inventoryTotal: true } } } } },
    }),
  ]);

  return Response.json({
    pid,
    title: product.title,
    description: product.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200),
    images: images.map((img) => `${config.siteUrl}/media/${img.id}`),
    variants: variants.map((v) => ({
      variantId: v.id,
      name: v.name,
      priceCents: v.priceCents,
      currency: "USD",
      image: v.imageUrl ? `${config.siteUrl}/media/v/${v.id}` : null,
      inStock: v.offer ? stockStatus(v.offer.cjSupplierVariant.inventoryTotal) !== "UNAVAILABLE" : false,
    })),
  });
}
