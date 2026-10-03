// Pure functions that turn raw CJ payloads into the fields we store. No I/O — unit tested.

import { priceToCents } from "@/lib/money";
import type { CjListV2Data, CjListV2Product, CjProductDetail, CjStockEntry, CjVariant } from "./types";

export interface SearchResult {
  pid: string;
  sku: string | null;
  name: string;
  image: string | null;
  priceCents: number | null;
  priceLabel: string | null;
  inventory: number | null;
  deliveryCycle: string | null;
  category: string | null;
  listedNum: number | null;
}

export function parseListV2(data: CjListV2Data | null | undefined): { items: SearchResult[]; total: number | null } {
  if (!data) return { items: [], total: null };
  const rows: CjListV2Product[] = [
    ...(data.content ?? []).flatMap((c) => c.productList ?? []),
    ...(data.list ?? []),
  ];
  const items = rows
    .filter((p) => p && (p.id || (p as { pid?: string }).pid))
    .map((p) => {
      const pid = String(p.id ?? (p as { pid?: string }).pid);
      const priceRaw = p.nowPrice ?? p.discountPrice ?? p.sellPrice ?? (p as { sellPrice?: unknown }).sellPrice;
      const inv = p.warehouseInventoryNum ?? p.totalVerifiedInventory;
      return {
        pid,
        sku: (p.sku ?? (p as { productSku?: string }).productSku ?? null) as string | null,
        name: String(p.nameEn ?? (p as { productNameEn?: string }).productNameEn ?? pid),
        image: (p.bigImage ?? (p as { productImage?: string }).productImage ?? null) as string | null,
        priceCents: priceToCents(priceRaw),
        priceLabel: priceRaw === undefined || priceRaw === null ? null : String(priceRaw),
        inventory: typeof inv === "number" ? inv : null,
        deliveryCycle: p.deliveryCycle === undefined || p.deliveryCycle === null ? null : String(p.deliveryCycle),
        category: (p.threeCategoryName ?? p.twoCategoryName ?? (p as { categoryName?: string }).categoryName ?? null) as
          | string
          | null,
        listedNum: typeof p.listedNum === "number" ? p.listedNum : null,
      };
    });
  return { items, total: data.totalRecords ?? data.total ?? null };
}

/** productImage can be a plain URL or a JSON-encoded array; productImageSet is an array. */
export function productImages(p: CjProductDetail): string[] {
  const out: string[] = [];
  const push = (u: unknown) => {
    if (typeof u === "string" && /^https?:\/\//.test(u.trim()) && !out.includes(u.trim())) out.push(u.trim());
  };
  if (Array.isArray(p.productImageSet)) p.productImageSet.forEach(push);
  if (typeof p.productImage === "string") {
    const s = p.productImage.trim();
    if (s.startsWith("[")) {
      try {
        (JSON.parse(s) as unknown[]).forEach(push);
      } catch {
        /* ignore */
      }
    } else s.split(",").forEach(push);
  }
  return out;
}

export function productName(p: CjProductDetail): string {
  if (p.productNameEn) return p.productNameEn;
  if (Array.isArray(p.productName)) return p.productName[0] ?? p.pid;
  if (typeof p.productName === "string") {
    try {
      const arr = JSON.parse(p.productName);
      if (Array.isArray(arr) && arr[0]) return String(arr[0]);
    } catch {
      /* not JSON */
    }
    return p.productName;
  }
  return p.pid;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export interface NormalizedVariant {
  cjVariantId: string;
  cjVariantSku: string;
  variantName: string | null;
  variantKey: string | null;
  variantImage: string | null;
  supplierPriceCents: number | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

export function normalizeVariant(v: CjVariant): NormalizedVariant {
  return {
    cjVariantId: String(v.vid),
    cjVariantSku: String(v.variantSku),
    variantName: (v.variantNameEn ?? v.variantName ?? null) || null,
    variantKey: v.variantKey ?? null,
    variantImage: v.variantImage ?? null,
    supplierPriceCents: priceToCents(v.variantSellPrice),
    weightGrams: num(v.variantWeight),
    lengthMm: num(v.variantLength),
    widthMm: num(v.variantWidth),
    heightMm: num(v.variantHeight),
  };
}

/**
 * Derive customer-facing option names/values from CJ's own keys.
 * CJ gives the product a key like "Color-Size" and each variant a key like "Black-30cm".
 * If the split doesn't line up we fall back to a single option holding the whole CJ key,
 * so options always originate from the real CJ variant — never invented.
 */
export function deriveOptions(
  productKeyEn: string | undefined,
  variants: Array<Pick<NormalizedVariant, "variantKey" | "variantName" | "cjVariantSku">>,
): { optionNames: string[]; values: Array<Record<string, string>> } {
  const names = (productKeyEn ?? "").split("-").map((s) => s.trim()).filter(Boolean);
  const keyOf = (v: (typeof variants)[number]) => (v.variantKey || v.variantName || v.cjVariantSku).trim();

  if (names.length > 1) {
    const split = variants.map((v) => keyOf(v).split("-").map((s) => s.trim()));
    if (split.every((parts) => parts.length === names.length)) {
      return {
        optionNames: names,
        values: split.map((parts) => Object.fromEntries(names.map((n, i) => [n, parts[i]]))),
      };
    }
  }
  const single = names.length === 1 ? names[0] : "Option";
  return { optionNames: [single], values: variants.map((v) => ({ [single]: keyOf(v) })) };
}

export function sumInventory(entries: CjStockEntry[] | null | undefined): number | null {
  if (!Array.isArray(entries)) return null;
  let total = 0;
  let seen = false;
  for (const e of entries) {
    const n = num(e.totalInventoryNum) ?? num(e.storageNum);
    if (n !== null) {
      total += n;
      seen = true;
    }
  }
  return seen ? total : entries.length === 0 ? 0 : null;
}

export function warehouseSummary(entries: CjStockEntry[] | null | undefined): Array<{ label: string; qty: number | null }> {
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => ({
    label: [e.countryCode, e.areaEn].filter(Boolean).join(" · ") || String(e.areaId ?? "?"),
    qty: num(e.totalInventoryNum) ?? num(e.storageNum),
  }));
}

/** Strip HTML and anything that would reveal the supplier to customers. */
export function toCustomerText(html: string | undefined | null): string {
  if (!html) return "";
  const text = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const lines = text
    .split("\n")
    // CJ copy often holds a literal "undefined" where an image or field was missing.
    .map((l) => l.replace(/\bundefined\b/gi, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1 && !/\bcj\b|cjdropshipping|dropship|amazon|walmart|temu|https?:\/\//i.test(l));
  // Drop section headings left with nothing under them (the next line is another heading, or none).
  const heading = /^(highlights?|specifications?|details|features|product (information|details)|description|packing list|package (contents|includes)|product image)\s*:?$/i;
  return lines
    .filter((l, i) => !heading.test(l) || (i + 1 < lines.length && !heading.test(lines[i + 1])))
    .join("\n")
    .slice(0, 4000);
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "product"
  );
}

/** A tidier starting title: drop supplier-ish noise; the merchant rebrands it anyway. */
export function suggestTitle(cjName: string): string {
  const cleaned = cjName
    .replace(/\bcj\w*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").slice(0, 8).join(" ");
  return words.replace(/\b\w/g, (c) => c.toUpperCase()) || "Untitled Product";
}
