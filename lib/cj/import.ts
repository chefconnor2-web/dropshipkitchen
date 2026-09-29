// Import one real CJ product (by PID) into our database.
//
//   CJ product/query + variant/query + stock/queryByVid
//     -> CjSupplierProduct / CjSupplierVariant   (supplier data, refreshed on every import)
//     -> Product / ProductVariant / SupplierOffer (our storefront data, created once as DRAFT;
//        re-imports never overwrite what the merchant has curated)

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { suggestRetailCents } from "@/lib/money";
import { refreshInventory } from "@/lib/inventory";
import { getProductDetail, getVariantsByPid } from "./client";
import {
  deriveOptions,
  normalizeVariant,
  productImages,
  productName,
  slugify,
  suggestTitle,
  toCustomerText,
} from "./normalize";

// Stock is fetched per VID (one CJ call each); cap the import-time fan-out, the rest refresh lazily.
const MAX_STOCK_CHECKS_ON_IMPORT = 30;

export interface ImportResult {
  productId: string;
  supplierProductId: string;
  created: boolean;
  variantCount: number;
  newVariants: number;
  stockChecked: number;
  stockErrors: string[];
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = slugify(base);
  for (let i = 2; await prisma.product.findUnique({ where: { slug } }); i++) slug = `${slugify(base)}-${i}`;
  return slug;
}

async function nextInternalSku(title: string): Promise<string> {
  const stop = new Set(["the", "a", "an", "for", "and", "with", "of", "kitchen", "stainless", "steel", "new"]);
  const word =
    title
      .split(/[^A-Za-z0-9]+/)
      .find((w) => w.length > 2 && !stop.has(w.toLowerCase()))
      ?.toUpperCase()
      .slice(0, 8) ?? "ITEM";
  for (let n = (await prisma.product.count()) + 1; ; n++) {
    const sku = `CS-${word}-${String(n).padStart(3, "0")}`;
    if (!(await prisma.product.findUnique({ where: { internalSku: sku } }))) return sku;
  }
}

export async function importCjProduct(pid: string, opts: { deliveryCycle?: string | null } = {}): Promise<ImportResult> {
  const detailEnv = await getProductDetail(pid);
  const detail = detailEnv.data;
  if (!detail?.pid) throw new Error(`CJ returned no product for PID ${pid}`);

  let rawVariants = detail.variants ?? [];
  if (rawVariants.length === 0) rawVariants = (await getVariantsByPid(pid)).data ?? [];
  if (rawVariants.length === 0) throw new Error(`CJ product ${pid} has no variants; nothing sellable to map.`);

  const variants = rawVariants.map((v) => ({ raw: v, n: normalizeVariant(v) }));
  const images = productImages(detail);
  const cjName = productName(detail);

  // ---- supplier layer ----
  const supplierData = {
    cjProductSku: String(detail.productSku),
    cjProductName: cjName,
    cjDescription: typeof detail.description === "string" ? detail.description : null,
    cjImages: JSON.stringify(images),
    cjCategoryName: typeof detail.categoryName === "string" ? detail.categoryName : null,
    cjProductWeight: typeof detail.productWeight === "number" ? detail.productWeight : Number(detail.productWeight) || null,
    cjSellPrice: detail.sellPrice === undefined ? null : String(detail.sellPrice),
    rawJson: JSON.stringify(detail),
    lastSyncedAt: new Date(),
    ...(opts.deliveryCycle ? { cjDeliveryCycle: opts.deliveryCycle } : {}),
  };
  const sp = await prisma.cjSupplierProduct.upsert({
    where: { cjProductId: String(detail.pid) },
    update: supplierData,
    create: { cjProductId: String(detail.pid), ...supplierData },
  });

  const svByVid = new Map<string, string>();
  for (const { raw, n } of variants) {
    const data = {
      supplierProductId: sp.id,
      cjVariantSku: n.cjVariantSku,
      variantName: n.variantName,
      variantKey: n.variantKey,
      variantImage: n.variantImage,
      supplierPriceCents: n.supplierPriceCents,
      priceCheckedAt: new Date(),
      weightGrams: n.weightGrams,
      lengthMm: n.lengthMm,
      widthMm: n.widthMm,
      heightMm: n.heightMm,
      rawJson: JSON.stringify(raw),
    };
    const sv = await prisma.cjSupplierVariant.upsert({
      where: { cjVariantId: n.cjVariantId },
      update: data,
      create: { cjVariantId: n.cjVariantId, ...data },
    });
    svByVid.set(n.cjVariantId, sv.id);
  }

  // ---- live inventory per exact VID ----
  let stockChecked = 0;
  const stockErrors: string[] = [];
  for (const { n } of variants.slice(0, MAX_STOCK_CHECKS_ON_IMPORT)) {
    try {
      await refreshInventory(svByVid.get(n.cjVariantId)!);
      stockChecked++;
    } catch (e) {
      stockErrors.push(`${n.cjVariantId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---- storefront layer ----
  const { optionNames, values } = deriveOptions(detail.productKeyEn, variants.map((v) => v.n));
  const existing = await prisma.product.findFirst({
    where: { supplierProductId: sp.id },
    include: { variants: { include: { offer: true } } },
  });

  if (existing) {
    // Add storefront variants for VIDs CJ added since the last import (disabled until reviewed).
    const mapped = new Set(existing.variants.map((v) => v.offer?.supplierVariantId).filter(Boolean));
    let added = 0;
    for (const [i, { n }] of variants.entries()) {
      if (mapped.has(n.cjVariantId)) continue;
      await createStorefrontVariant(existing.id, existing.internalSku, existing.variants.length + added, {
        options: values[i],
        n,
        detail,
        svId: svByVid.get(n.cjVariantId)!,
        enabled: false,
      });
      added++;
    }
    return {
      productId: existing.id,
      supplierProductId: sp.id,
      created: false,
      variantCount: variants.length,
      newVariants: added,
      stockChecked,
      stockErrors,
    };
  }

  const title = suggestTitle(cjName);
  const internalSku = await nextInternalSku(title);
  const product = await prisma.product.create({
    data: {
      slug: await uniqueSlug(title),
      title,
      description: toCustomerText(detail.description),
      internalSku,
      categories: "",
      status: "DRAFT",
      optionNames: JSON.stringify(optionNames),
      supplierProductId: sp.id,
      images: { create: images.slice(0, 8).map((sourceUrl, position) => ({ sourceUrl, position, alt: title })) },
    },
  });
  for (const [i, { n }] of variants.entries()) {
    await createStorefrontVariant(product.id, internalSku, i, {
      options: values[i],
      n,
      detail,
      svId: svByVid.get(n.cjVariantId)!,
      enabled: true,
    });
  }
  return {
    productId: product.id,
    supplierProductId: sp.id,
    created: true,
    variantCount: variants.length,
    newVariants: variants.length,
    stockChecked,
    stockErrors,
  };
}

async function createStorefrontVariant(
  productId: string,
  productSku: string,
  index: number,
  a: {
    options: Record<string, string>;
    n: ReturnType<typeof normalizeVariant>;
    detail: { pid: string; productSku: string };
    svId: string;
    enabled: boolean;
  },
) {
  let internalSku = `${productSku}-${String(index + 1).padStart(2, "0")}`;
  for (let k = index + 2; await prisma.productVariant.findUnique({ where: { internalSku } }); k++)
    internalSku = `${productSku}-${String(k).padStart(2, "0")}`;

  await prisma.productVariant.create({
    data: {
      productId,
      name: Object.values(a.options).join(" / "),
      options: JSON.stringify(a.options),
      internalSku,
      priceCents: suggestRetailCents(a.n.supplierPriceCents, config.pricing.defaultMarkup),
      imageUrl: a.n.variantImage,
      enabled: a.enabled,
      position: index,
      offer: {
        create: {
          supplier: "CJ",
          supplierProductId: String(a.detail.pid),
          supplierProductSku: String(a.detail.productSku),
          supplierVariantId: a.n.cjVariantId,
          supplierSku: a.n.cjVariantSku,
          cjSupplierVariantId: a.svId,
        },
      },
    },
  });
}
