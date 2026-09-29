// Customer-safe views of our catalog. Everything returned from here may reach the browser,
// so supplier identifiers, supplier prices and raw stock counts are deliberately excluded.

import { prisma } from "@/lib/db";
import { stockLabel, stockStatus, type StockStatus } from "@/lib/inventory";

export interface PublicVariant {
  id: string;
  name: string;
  options: Record<string, string>;
  priceCents: number;
  stock: StockStatus;
  stockLabel: string;
  imageSrc: string | null;
}

export interface PublicProduct {
  id: string;
  slug: string;
  title: string;
  description: string;
  categories: string[];
  seoTitle: string | null;
  seoDescription: string | null;
  estimatedDelivery: string | null;
  optionNames: string[];
  images: Array<{ src: string; alt: string }>;
  variants: PublicVariant[];
  fromPriceCents: number | null;
  stock: StockStatus;
}

const include = {
  images: { orderBy: { position: "asc" as const } },
  variants: {
    where: { enabled: true },
    orderBy: { position: "asc" as const },
    include: { offer: { include: { cjSupplierVariant: { select: { inventoryTotal: true } } } } },
  },
};

type Loaded = NonNullable<Awaited<ReturnType<typeof loadBySlug>>>;

function loadBySlug(slug: string) {
  return prisma.product.findFirst({ where: { slug, status: "PUBLISHED" }, include });
}

function toPublic(p: Loaded): PublicProduct {
  const variants: PublicVariant[] = p.variants
    .filter((v) => v.offer)
    .map((v) => {
      const s = stockStatus(v.offer?.cjSupplierVariant.inventoryTotal);
      return {
        id: v.id,
        name: v.name,
        options: JSON.parse(v.options || "{}"),
        priceCents: v.priceCents,
        stock: s,
        stockLabel: stockLabel(s),
        imageSrc: v.imageUrl ? `/media/v/${v.id}` : null,
      };
    });
  const buyable = variants.filter((v) => v.stock !== "UNAVAILABLE");
  const order: StockStatus[] = ["IN_STOCK", "LOW_STOCK", "UNKNOWN", "UNAVAILABLE"];
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    categories: p.categories.split(",").map((c) => c.trim()).filter(Boolean),
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    estimatedDelivery: p.estimatedDelivery,
    optionNames: JSON.parse(p.optionNames || "[]"),
    images: p.images.map((i) => ({ src: `/media/${i.id}`, alt: i.alt || p.title })),
    variants,
    fromPriceCents: (buyable.length ? buyable : variants).reduce<number | null>(
      (m, v) => (m === null || v.priceCents < m ? v.priceCents : m),
      null,
    ),
    stock: variants.map((v) => v.stock).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "UNAVAILABLE",
  };
}

export async function publishedProducts(): Promise<PublicProduct[]> {
  const rows = await prisma.product.findMany({ where: { status: "PUBLISHED" }, include, orderBy: { updatedAt: "desc" } });
  return rows.map(toPublic);
}

export async function publishedProduct(slug: string): Promise<PublicProduct | null> {
  const p = await loadBySlug(slug);
  return p ? toPublic(p) : null;
}
