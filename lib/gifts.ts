// Gifts: the merchant sends a free branded item (a Chit water bottle, say) to people they pick. Each person
// gets an email with a claim link, enters where to ship it, and that becomes a $0 order carrying the design,
// which goes through normal CJ fulfilment: the merchant approves it and CJ is paid from the CJ balance. Nobody
// is charged. Before sending, the merchant sees what each gift should cost (product + shipping estimate) and
// sets a budget the send can't exceed.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { sendEmail } from "@/lib/email";
import { newOrderNumber, ORDER_STATUS } from "@/lib/orders";
import { linkOrderToCustomer } from "@/lib/customers";
import { sendOrderEmail } from "@/lib/order-emails";
import { createPersonalization } from "@/lib/personalize";
import { parsePersonalizeConfig } from "@/lib/personalize-shared";
import { fastShipView } from "@/lib/ship-view";
import { SHIP_COUNTRY_CODES } from "@/lib/countries";
import { normalizePhone } from "@/lib/flight-booking";
import { formatMoney } from "@/lib/money";

export const GIFT_STATUS = { SENT: "SENT", CLAIMED: "CLAIMED", CANCELLED: "CANCELLED" } as const;

/** The print-ready art in public/brand/print (2000×2000 transparent PNGs). */
export const GIFT_DESIGNS = {
  dark: { label: "Logo, dark lettering (for light items)", file: "chit-logo-dark.png" },
  light: { label: "Logo, light lettering (for dark items)", file: "chit-logo-light.png" },
  mascot: { label: "Bubble Guy only", file: "bubble-guy.png" },
} as const;
export type GiftDesign = keyof typeof GIFT_DESIGNS;

export const MAX_GIFTS_PER_SEND = 50;
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

/** "sam@x.com, Sam Lee" or "Sam Lee <sam@x.com>" or just an email, one per line; duplicates dropped. */
export function parseRecipients(text: string): { recipients: Array<{ email: string; name: string | null }>; bad: string[] } {
  const recipients: Array<{ email: string; name: string | null }> = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const angled = /^(.*?)<([^>]+)>\s*$/.exec(line);
    let email = "";
    let name = "";
    if (angled) [email, name] = [angled[2], angled[1]];
    else {
      const parts = line.split(/[,;\t]/).map((s) => s.trim());
      const i = parts.findIndex((p) => EMAIL.test(p));
      if (i >= 0) [email, name] = [parts[i], parts.filter((_, j) => j !== i).join(" ")];
    }
    email = email.trim().toLowerCase();
    name = name.replace(/["']/g, "").trim();
    if (!EMAIL.test(email) || email.length > 254) bad.push(line);
    else if (!recipients.some((r) => r.email === email)) recipients.push({ email, name: name.slice(0, 80) || null });
  }
  return { recipients, bad };
}

export interface GiftableVariant {
  variantId: string;
  label: string;
  image: string | null;
  /** CJ's price for the item, USD ×100. */
  productCents: number | null;
  inStock: boolean;
}

/** Variants that can carry a printed design: published print-on-demand products that take a photo/logo. */
export async function giftableVariants(): Promise<GiftableVariant[]> {
  const products = await prisma.product.findMany({
    where: { status: "PUBLISHED", personalizeJson: { not: null } },
    include: { images: { take: 1, orderBy: { position: "asc" } }, variants: { where: { enabled: true }, orderBy: { position: "asc" }, include: { offer: { include: { cjSupplierVariant: true } } } } },
    orderBy: { updatedAt: "desc" },
  });
  return products
    .filter((p) => parsePersonalizeConfig(p.personalizeJson)?.allowPhoto)
    .flatMap((p) =>
      p.variants
        .filter((v) => v.offer)
        .map((v) => ({
          variantId: v.id,
          label: p.variants.length > 1 ? `${p.title} — ${v.name}` : p.title,
          image: v.imageUrl ? `/media/v/${v.id}` : p.images[0] ? `/media/${p.images[0].id}` : null,
          productCents: v.offer!.cjSupplierVariant.supplierPriceCents,
          inStock: (v.offer!.cjSupplierVariant.inventoryTotal ?? 1) > 0,
        })),
    );
}

/** What one gift should cost to Canada and the US: CJ's item price plus the cheapest known shipping. */
export async function giftEstimate(v: Pick<GiftableVariant, "variantId" | "productCents">) {
  const ship = async (country: string) => {
    const view = await fastShipView(v.variantId, 1, country, "").catch(() => null);
    return view?.tiers.length ? Math.min(...view.tiers.map((t) => t.cents)) : null;
  };
  const [ca, us] = await Promise.all([ship("CA"), ship("US")]);
  const known = [ca, us].filter((c): c is number => c != null);
  // Unknown shipping: assume a generous $20 so the budget check stays on the safe side.
  const worstShip = known.length ? Math.max(...known) : 2000;
  return { ca, us, perGiftCents: (v.productCents ?? 0) + worstShip, shippingKnown: known.length > 0 };
}

export function giftUrl(token: string): string {
  return `${config.siteUrl}/gift/${token}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Creates the gifts and emails each person their claim link. Refuses anything over the budget. */
export async function sendGifts(input: { variantId: string; design: GiftDesign; recipients: Array<{ email: string; name: string | null }>; message: string; budgetCents: number }) {
  const variants = await giftableVariants();
  const v = variants.find((x) => x.variantId === input.variantId);
  if (!v) return { error: "Choose an item that can be printed with your logo." };
  if (!v.inStock) return { error: "That item is out of stock at CJ right now." };
  if (!GIFT_DESIGNS[input.design]) return { error: "Choose a design." };
  // Nobody gets the same gift twice from one send, or a second one while their first is unclaimed.
  const open = new Set((await prisma.gift.findMany({ where: { status: GIFT_STATUS.SENT, email: { in: input.recipients.map((r) => r.email) } }, select: { email: true } })).map((g) => g.email));
  const recipients = input.recipients.filter((r) => !open.has(r.email));
  if (!recipients.length) return { error: open.size ? "Everyone listed already has an unclaimed gift." : "Add at least one person." };
  if (recipients.length > MAX_GIFTS_PER_SEND) return { error: `Send up to ${MAX_GIFTS_PER_SEND} at a time.` };
  const est = await giftEstimate(v);
  const total = est.perGiftCents * recipients.length;
  if (!(input.budgetCents > 0)) return { error: "Set a budget for this send." };
  if (total > input.budgetCents)
    return { error: `${recipients.length} gifts could cost up to ${formatMoney(total)} (${formatMoney(est.perGiftCents)} each), more than your ${formatMoney(input.budgetCents)} budget. Raise the budget or pick fewer people.` };

  const art = await readFile(path.join(process.cwd(), "public/brand/print", GIFT_DESIGNS[input.design].file));
  const design = await createPersonalization({ variantId: v.variantId, kind: "photo", art, preview: art });
  if (!design.ok) return { error: design.message };

  const message = input.message.trim().slice(0, 500);
  const item = v.label;
  let sent = 0;
  for (const r of recipients) {
    const gift = await prisma.gift.create({
      data: { token: randomBytes(18).toString("base64url"), email: r.email, name: r.name, message: message || null, productVariantId: v.variantId, personalizationId: design.id, estimateCents: est.perGiftCents },
    });
    const url = giftUrl(gift.token);
    const hi = r.name ? `Hi ${r.name.split(" ")[0]},` : "Hi,";
    const text = `${hi}\n\n${message || `Thanks for being one of the first people to use ${config.storeName}. We'd love to send you something.`}\n\nWe're sending you a free ${item} with the ${config.storeName} logo. Tell us where to ship it (it's on us, nothing to pay):\n\n${url}\n\n${config.storeName}`;
    await sendEmail({
      to: r.email,
      kind: "gift_invite",
      subject: `${config.storeName} is sending you a free ${item}`,
      text,
      html: `<div style="font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1D1C1A;max-width:520px">
<p>${esc(hi)}</p><p>${esc(message || `Thanks for being one of the first people to use ${config.storeName}. We'd love to send you something.`)}</p>
<p>We're sending you a free <strong>${esc(item)}</strong> with the ${esc(config.storeName)} logo. Tell us where to ship it. It's on us, nothing to pay.</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#E8551C;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">Claim your gift</a></p>
<p style="color:#6B6760">${esc(config.storeName)}</p></div>`,
    });
    sent++;
  }
  return { sent, skipped: open.size, perGiftCents: est.perGiftCents };
}

export interface ClaimInput {
  name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal: string;
  country: string;
}

/** Checks a claim form; returns the cleaned address or what to fix. */
export function checkClaim(f: ClaimInput): { ok: true; address: ClaimInput & { phone: string } } | { ok: false; error: string } {
  const t = (s: string, n: number) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, n);
  const a = { name: t(f.name, 80), phone: t(f.phone, 30), line1: t(f.line1, 120), line2: t(f.line2, 120), city: t(f.city, 80), state: t(f.state, 80), postal: t(f.postal, 20).toUpperCase(), country: t(f.country, 2).toUpperCase() };
  if (a.name.length < 2) return { ok: false, error: "Enter your full name for the label." };
  if (!SHIP_COUNTRY_CODES.has(a.country)) return { ok: false, error: "Choose a country we ship to." };
  if (a.line1.length < 3 || a.city.length < 2) return { ok: false, error: "Enter your street address and city." };
  if (["CA", "US", "AU"].includes(a.country) && a.state.length < 2) return { ok: false, error: "Enter your province or state." };
  if (a.postal.length < 3) return { ok: false, error: "Enter your postal code." };
  const phone = normalizePhone(a.phone);
  if (!phone) return { ok: false, error: "Enter a phone number (couriers text about delivery)." };
  return { ok: true, address: { ...a, phone } };
}

/** Claims a gift: one $0 order with the design, waiting for the merchant to approve it as usual. */
export async function claimGift(token: string, form: ClaimInput): Promise<{ ok: true; orderNumber: string } | { ok: false; error: string }> {
  const gift = await prisma.gift.findUnique({ where: { token } });
  if (!gift || gift.status === GIFT_STATUS.CANCELLED) return { ok: false, error: "This gift link isn't valid any more." };
  if (gift.status === GIFT_STATUS.CLAIMED) return { ok: false, error: "This gift has already been claimed." };
  const checked = checkClaim(form);
  if (!checked.ok) return checked;
  const a = checked.address;
  const v = await prisma.productVariant.findUnique({ where: { id: gift.productVariantId }, include: { product: true, offer: { include: { cjSupplierVariant: true } } } });
  if (!v?.offer) return { ok: false, error: "Sorry, this item isn't available any more. We'll be in touch." };

  // One claim only, even with two tabs: the gift moves SENT → CLAIMED first.
  const locked = await prisma.gift.updateMany({ where: { id: gift.id, status: GIFT_STATUS.SENT }, data: { status: GIFT_STATUS.CLAIMED, claimedAt: new Date() } });
  if (!locked.count) return { ok: false, error: "This gift has already been claimed." };
  try {
    const offer = v.offer;
    const order = await prisma.order.create({
      data: {
        number: newOrderNumber(),
        status: ORDER_STATUS.AWAITING_MERCHANT_APPROVAL,
        email: gift.email,
        customerName: a.name,
        customerPhone: a.phone,
        shippingAddressJson: JSON.stringify({ name: a.name, phone: a.phone, address: { line1: a.line1, line2: a.line2 || null, city: a.city, state: a.state || null, postal_code: a.postal, country: a.country } }),
        subtotalCents: 0,
        shippingCents: 0,
        customerShipCountry: a.country,
        paidAt: new Date(),
        decisionNote: `Gift from you to ${a.name}: free, nothing was charged.${gift.estimateCents ? ` Approving places the CJ order, paid from your CJ balance (about ${formatMoney(gift.estimateCents)}).` : ""}`,
        items: {
          create: [
            {
              productId: v.productId,
              productVariantId: v.id,
              productTitle: v.product.title,
              variantName: v.name,
              internalSku: v.internalSku,
              quantity: 1,
              customerPriceCents: 0,
              supplier: offer.supplier,
              supplierProductId: offer.supplierProductId,
              supplierProductSku: offer.supplierProductSku,
              supplierVariantId: offer.supplierVariantId,
              supplierSku: offer.supplierSku,
              supplierPriceAtOrderCents: offer.cjSupplierVariant.supplierPriceCents,
              supplierInventoryAtOrder: offer.cjSupplierVariant.inventoryTotal,
              supplierInventoryCheckedAt: offer.cjSupplierVariant.inventoryCheckedAt,
              personalizationId: gift.personalizationId,
            },
          ],
        },
      },
    });
    await prisma.gift.update({ where: { id: gift.id }, data: { orderId: order.id } });
    await linkOrderToCustomer(order.id);
    await sendOrderEmail(order.id, "merchant_new_order");
    await sendEmail({
      to: gift.email,
      orderId: order.id,
      kind: "gift_claimed",
      subject: `Your ${config.storeName} ${v.product.title} is on its way to being made`,
      text: `Thanks ${a.name.split(" ")[0]}! We've got your address and your ${v.product.title} is being printed with the ${config.storeName} logo. We'll email you tracking as soon as it ships (order ${order.number}).\n\n${config.storeName}`,
      html: `<p style="font:15px/1.55 -apple-system,Segoe UI,sans-serif">Thanks ${esc(a.name.split(" ")[0])}! We've got your address and your ${esc(v.product.title)} is being printed with the ${esc(config.storeName)} logo. We'll email you tracking as soon as it ships (order ${esc(order.number)}).</p>`,
    });
    return { ok: true, orderNumber: order.number };
  } catch (e) {
    console.error("[gifts] claim failed:", e);
    await prisma.gift.update({ where: { id: gift.id }, data: { status: GIFT_STATUS.SENT, claimedAt: null } });
    return { ok: false, error: "Something went wrong saving your address. Please try again." };
  }
}

export async function cancelGift(id: string) {
  await prisma.gift.updateMany({ where: { id, status: GIFT_STATUS.SENT }, data: { status: GIFT_STATUS.CANCELLED } });
}
