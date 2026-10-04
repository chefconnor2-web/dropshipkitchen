"use server";

import { payCjOrder, placeCjOrder, quoteShipping, refreshCjOrder } from "@/lib/fulfillment";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { testConnection } from "@/lib/cj/client";
import { importCjProduct } from "@/lib/cj/import";
import { slugify } from "@/lib/cj/normalize";
import { refreshLive } from "@/lib/inventory";
import { approveOrder, declineAndRefund, recheckOrderSupplierData } from "@/lib/orders";
import { sendOrderEmail, sendTestEmail, type OrderEmailKind } from "@/lib/order-emails";

function msg(e: unknown) {
  return encodeURIComponent(e instanceof Error ? e.message : String(e));
}

export async function testCjConnection(form: FormData) {
  const back = String(form.get("back") || "/admin/suppliers/cj");
  let err: string | null = null;
  try {
    await testConnection();
  } catch (e) {
    err = msg(e);
  }
  revalidatePath("/admin", "layout");
  redirect(err ? `${back}${back.includes("?") ? "&" : "?"}error=${err}` : back);
}

export async function importProduct(form: FormData) {
  const pid = String(form.get("pid") || "");
  const deliveryCycle = String(form.get("deliveryCycle") || "") || null;
  let target: string;
  try {
    const r = await importCjProduct(pid, { deliveryCycle });
    const note = r.created
      ? `Imported ${r.variantCount} real CJ variants (stock checked for ${r.stockChecked}).`
      : `Supplier data re-synced; ${r.newVariants} new variant(s) added as disabled.`;
    target = `/admin/products/${r.productId}?notice=${encodeURIComponent(note + (r.stockErrors.length ? ` ${r.stockErrors.length} stock check(s) failed.` : ""))}`;
  } catch (e) {
    const back = String(form.get("back") || "/admin/suppliers/cj");
    target = `${back}${back.includes("?") ? "&" : "?"}error=${msg(e)}`;
  }
  revalidatePath("/", "layout");
  redirect(target);
}

export async function saveProduct(form: FormData) {
  const id = String(form.get("id"));
  const title = String(form.get("title") || "").trim();
  const slugInput = String(form.get("slug") || "").trim();
  const internalSku = String(form.get("internalSku") || "").trim();
  let error: string | null = null;
  try {
    if (!title) throw new Error("Title is required.");
    if (!internalSku) throw new Error("Internal SKU is required.");
    const before = await prisma.product.findUniqueOrThrow({ where: { id }, select: { internalSku: true } });
    await prisma.product.update({
      where: { id },
      data: {
        title,
        slug: slugify(slugInput || title),
        internalSku,
        description: String(form.get("description") || ""),
        categories: String(form.get("categories") || ""),
        seoTitle: String(form.get("seoTitle") || "") || null,
        seoDescription: String(form.get("seoDescription") || "") || null,
        estimatedDelivery: String(form.get("estimatedDelivery") || "") || null,
      },
    });
    const variants = await prisma.productVariant.findMany({ where: { productId: id } });
    for (const v of variants) {
      const name = String(form.get(`name_${v.id}`) ?? v.name).trim() || v.name;
      await prisma.productVariant.update({
        where: { id: v.id },
        data: {
          enabled: form.get(`enabled_${v.id}`) === "on",
          name,
          // Keep variant SKUs under the product SKU when the merchant renames it.
          ...(before.internalSku !== internalSku && v.internalSku.startsWith(`${before.internalSku}-`)
            ? { internalSku: internalSku + v.internalSku.slice(before.internalSku.length) }
            : {}),
        },
      });
    }
    await prisma.productImage.updateMany({ where: { productId: id }, data: { alt: title } });
  } catch (e) {
    error = e instanceof Error && e.message.includes("Unique constraint") ? "Slug or internal SKU is already in use." : String(e instanceof Error ? e.message : e);
  }
  revalidatePath("/", "layout");
  redirect(`/admin/products/${id}?${error ? `error=${encodeURIComponent(error)}` : "notice=Saved"}`);
}

export async function setPublished(form: FormData) {
  const id = String(form.get("id"));
  const publish = form.get("publish") === "1";
  await prisma.product.update({ where: { id }, data: { status: publish ? "PUBLISHED" : "DRAFT" } });
  revalidatePath("/", "layout");
  redirect(`/admin/products/${id}?notice=${publish ? "Published to storefront" : "Unpublished"}`);
}

export async function removeImage(form: FormData) {
  const id = String(form.get("imageId"));
  const img = await prisma.productImage.delete({ where: { id } });
  revalidatePath("/", "layout");
  redirect(`/admin/products/${img.productId}`);
}

export async function addImage(form: FormData) {
  const productId = String(form.get("productId"));
  const url = String(form.get("url") || "").trim();
  if (/^https:\/\//.test(url)) {
    const count = await prisma.productImage.count({ where: { productId } });
    await prisma.productImage.create({ data: { productId, sourceUrl: url, position: count } });
  }
  revalidatePath("/", "layout");
  redirect(`/admin/products/${productId}`);
}

export async function refreshVariantLive(form: FormData) {
  const svId = String(form.get("cjSupplierVariantId"));
  const back = String(form.get("back") || "/admin");
  let err: string | null = null;
  try {
    await refreshLive(svId);
  } catch (e) {
    err = msg(e);
  }
  revalidatePath("/", "layout");
  redirect(err ? `${back}${back.includes("?") ? "&" : "?"}error=${err}` : back);
}

export async function refreshOrderCj(form: FormData) {
  const id = String(form.get("orderId"));
  await recheckOrderSupplierData(id);
  revalidatePath(`/admin/orders/${id}`);
  redirect(`/admin/orders/${id}?notice=${encodeURIComponent("Live CJ data refreshed")}`);
}

export async function approveOrderAction(form: FormData) {
  const id = String(form.get("orderId"));
  let q = "notice=" + encodeURIComponent("Approved (mock fulfillment — no CJ order placed)");
  try {
    await approveOrder(id);
  } catch (e) {
    q = `error=${msg(e)}`;
  }
  redirect(`/admin/orders/${id}?${q}`);
}

export async function declineOrderAction(form: FormData) {
  const id = String(form.get("orderId"));
  let q = "notice=" + encodeURIComponent("Declined and refunded (Stripe test mode)");
  try {
    await declineAndRefund(id, String(form.get("note") || "") || undefined);
  } catch (e) {
    q = `error=${msg(e)}`;
  }
  redirect(`/admin/orders/${id}?${q}`);
}

// ---- CJ fulfilment (lib/fulfillment.ts gates every call on SUPPLIER_MODE) ----

function orderBack(id: string, q: string) {
  revalidatePath(`/admin/orders/${id}`);
  redirect(`/admin/orders/${id}?${q}`);
}

export async function quoteShippingAction(form: FormData) {
  const id = String(form.get("orderId"));
  let q = "notice=" + encodeURIComponent("Live CJ shipping quote loaded");
  try {
    await quoteShipping(id);
  } catch (e) {
    q = `error=${msg(e)}`;
  }
  orderBack(id, q);
}

export async function placeCjOrderAction(form: FormData) {
  const id = String(form.get("orderId"));
  const sandbox = form.get("kind") !== "real";
  const logisticName = String(form.get("logisticName") || "");
  let q = "notice=" + encodeURIComponent(sandbox ? "CJ sandbox order placed (simulated payment, nothing shipped)" : "Real CJ order placed and paid from your CJ balance");
  try {
    if (!logisticName) throw new Error("Choose a shipping method first.");
    if (!sandbox && form.get("confirmReal") !== "yes")
      throw new Error("Tick the confirmation box to place a real, paid CJ order.");
    await placeCjOrder(id, { logisticName, sandbox });
  } catch (e) {
    q = `error=${msg(e)}`;
  }
  orderBack(id, q);
}

export async function payCjOrderAction(form: FormData) {
  const id = String(form.get("orderId"));
  let q = "notice=" + encodeURIComponent("CJ order paid");
  try {
    await payCjOrder(id);
  } catch (e) {
    q = `error=${msg(e)}`;
  }
  orderBack(id, q);
}

export async function refreshCjOrderAction(form: FormData) {
  const id = String(form.get("orderId"));
  let q = "notice=" + encodeURIComponent("CJ order status refreshed");
  try {
    await refreshCjOrder(id);
  } catch (e) {
    q = `error=${msg(e)}`;
  }
  orderBack(id, q);
}

export async function saveCustomerAction(form: FormData) {
  const id = String(form.get("customerId"));
  const tags = String(form.get("tags") || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join(", ");
  await prisma.customer.update({
    where: { id },
    data: {
      name: String(form.get("name") || "").trim() || null,
      phone: String(form.get("phone") || "").trim() || null,
      notes: String(form.get("notes") || "").slice(0, 5000),
      tags,
    },
  });
  revalidatePath(`/admin/customers/${id}`);
  redirect(`/admin/customers/${id}?notice=${encodeURIComponent("Customer saved")}`);
}

export async function sendTestEmailAction(form: FormData) {
  const to = String(form.get("to") || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) redirect(`/admin/emails?error=${encodeURIComponent("Enter a valid email address.")}`);
  const log = await sendTestEmail(to);
  revalidatePath("/admin/emails");
  if (log.status === "sent") redirect(`/admin/emails?notice=${encodeURIComponent(`Test email sent to ${to}. Check the inbox (and spam).`)}`);
  redirect(`/admin/emails?error=${encodeURIComponent(log.error || "Email not sent.")}`);
}

export async function resendOrderEmailAction(form: FormData) {
  const id = String(form.get("id") || "");
  const kind = String(form.get("kind") || "") as OrderEmailKind;
  const log = await sendOrderEmail(id, kind, { force: true });
  revalidatePath(`/admin/orders/${id}`);
  const q = !log
    ? `error=${encodeURIComponent("Nothing to send: the order has no email address yet, or no tracking number.")}`
    : log.status === "sent"
      ? `notice=${encodeURIComponent(`Email sent to ${log.to}`)}`
      : `error=${encodeURIComponent(log.error || "Email not sent.")}`;
  redirect(`/admin/orders/${id}?${q}`);
}

export async function setFreightStatusAction(form: FormData) {
  const id = String(form.get("id") || "");
  const status = String(form.get("status") || "");
  if (!["new", "quoted", "won", "lost"].includes(status)) redirect("/admin/freight");
  await prisma.freightRequest.update({ where: { id }, data: { status } });
  revalidatePath("/admin/freight");
  redirect("/admin/freight?notice=" + encodeURIComponent(`Marked ${status}`));
}
