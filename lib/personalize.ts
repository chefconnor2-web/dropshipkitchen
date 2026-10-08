// Server side of print-on-demand personalization: storing a shopper's design and turning it into the
// podProperties CJ prints from. See lib/personalize-shared.ts for the set-up and the CJ format.

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { buildPodProperties, designerConfig, parsePersonalizeConfig, podUrls, type DesignerConfig } from "@/lib/personalize-shared";
import { stockStatus } from "@/lib/inventory";

export const MAX_ART_BYTES = 12 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;

/** The image type from its first bytes (PNG or JPEG only), or null. Never trust the browser's label. */
export function sniffImage(buf: Uint8Array): "image/png" | "image/jpeg" | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

export type DesignInput = {
  variantId: string;
  kind: string;
  text?: string | null;
  art: Uint8Array;
  preview: Uint8Array;
};

/** Validates and stores a design for one variant of a personalizable product. */
export async function createPersonalization(input: DesignInput): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const variant = await prisma.productVariant.findUnique({ where: { id: input.variantId }, include: { product: true, offer: true } });
  if (!variant || !variant.enabled || !variant.offer || variant.product.status !== "PUBLISHED") return { ok: false, message: "Please choose an available option." };
  const cfg = parsePersonalizeConfig(variant.product.personalizeJson);
  if (!cfg) return { ok: false, message: "This item can’t be personalized." };

  const kind = input.kind === "text" ? "text" : input.kind === "photo" ? "photo" : null;
  if (!kind || (kind === "photo" && !cfg.allowPhoto) || (kind === "text" && !cfg.allowText)) return { ok: false, message: "That kind of design isn’t offered for this item." };
  const text = kind === "text" ? String(input.text ?? "").trim() : null;
  if (kind === "text" && (!text || text.length > cfg.maxTextLength)) return { ok: false, message: `Enter up to ${cfg.maxTextLength} characters of text.` };

  const artMime = sniffImage(input.art);
  const previewMime = sniffImage(input.preview);
  if (!artMime || !previewMime) return { ok: false, message: "The design must be a PNG or JPEG image." };
  if (input.art.length > MAX_ART_BYTES) return { ok: false, message: "That photo is too large. Try a smaller one." };
  if (input.preview.length > MAX_PREVIEW_BYTES) return { ok: false, message: "The preview is too large." };

  await pruneAbandonedDesigns().catch(() => null);
  const row = await prisma.personalization.create({
    data: {
      productId: variant.productId,
      variantId: variant.id,
      kind,
      text,
      podVersion: cfg.podVersion,
      areaName: cfg.areaName,
      artMime,
      art: Buffer.from(input.art),
      previewMime,
      preview: Buffer.from(input.preview),
    },
    select: { id: true },
  });
  return { ok: true, id: row.id };
}

const ABANDONED_DAYS = 14;

/** Deletes designs older than two weeks that never reached an order and sit in no cart (they fill the volume). */
export async function pruneAbandonedDesigns() {
  const old = await prisma.personalization.findMany({
    where: { createdAt: { lt: new Date(Date.now() - ABANDONED_DAYS * 86_400_000) }, cartItems: { none: {} } },
    select: { id: true },
    take: 200,
  });
  if (!old.length) return 0;
  const ordered = new Set(
    (await prisma.orderItem.findMany({ where: { personalizationId: { in: old.map((o) => o.id) } }, select: { personalizationId: true } })).map((o) => o.personalizationId),
  );
  // A gift's design waits for its recipients to claim it, however long that takes.
  for (const g of await prisma.gift.findMany({ where: { personalizationId: { in: old.map((o) => o.id) } }, select: { personalizationId: true } })) ordered.add(g.personalizationId);
  const ids = old.map((o) => o.id).filter((id) => !ordered.has(id));
  return ids.length ? (await prisma.personalization.deleteMany({ where: { id: { in: ids } } })).count : 0;
}

/** Customer-facing one-liner for a design, for the cart, Stripe and emails. */
export function designLabel(p: { kind: string; text: string | null } | null | undefined): string | null {
  if (!p) return null;
  return p.kind === "text" && p.text ? `Personalized: “${p.text}”` : "Personalized with your photo";
}

/** CJ can only download artwork from a public https address. */
export function podSiteProblem(siteUrl = config.siteUrl): string | null {
  try {
    const u = new URL(siteUrl);
    if (u.protocol !== "https:" || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname))
      return `CJ downloads personalized artwork from SITE_URL, which must be this store's public https address (it is ${siteUrl}).`;
    return null;
  } catch {
    return `SITE_URL (${siteUrl}) is not a valid address, so CJ can't download personalized artwork.`;
  }
}

/** podProperties per order line id, for lines with a design. Throws if a design is missing or can't be sent. */
export async function podPropertiesForItems(items: Array<{ id: string; personalizationId: string | null }>): Promise<Map<string, string>> {
  const ids = items.map((i) => i.personalizationId).filter((x): x is string => !!x);
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const problem = podSiteProblem();
  if (problem) throw new Error(problem);
  const rows = await prisma.personalization.findMany({ where: { id: { in: ids } }, select: { id: true, podVersion: true, areaName: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const i of items) {
    if (!i.personalizationId) continue;
    const p = byId.get(i.personalizationId);
    if (!p) throw new Error("A personalized item's design is missing, so CJ would have nothing to print. Decline and refund this order.");
    const urls = podUrls(config.siteUrl, p.id);
    out.set(i.id, buildPodProperties(p, urls.art, urls.preview));
  }
  return out;
}

export interface ChatDesigner {
  title: string;
  config: DesignerConfig;
  imageSrc: string | null;
  options: Array<{ id: string; name: string; priceCents: number; available: boolean; imageSrc: string | null }>;
}

/** What the chat needs to open the designer for a product, or null when it isn't personalizable. */
export async function chatDesigner(productId: string): Promise<ChatDesigner | null> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      images: { orderBy: { position: "asc" }, take: 1 },
      variants: { where: { enabled: true }, orderBy: { position: "asc" }, take: 60, include: { offer: { include: { cjSupplierVariant: { select: { inventoryTotal: true } } } } } },
    },
  });
  const config = designerConfig(parsePersonalizeConfig(p?.personalizeJson));
  if (!p || !config || p.status !== "PUBLISHED") return null;
  return {
    title: p.title,
    config,
    imageSrc: p.images[0] ? `/media/${p.images[0].id}` : null,
    options: p.variants
      .filter((v) => v.offer)
      .map((v) => ({
        id: v.id,
        name: v.name,
        priceCents: v.priceCents,
        available: stockStatus(v.offer?.cjSupplierVariant.inventoryTotal) !== "UNAVAILABLE",
        imageSrc: v.imageUrl ? `/media/v/${v.id}` : null,
      })),
  };
}
