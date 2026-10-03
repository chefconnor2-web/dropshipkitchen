"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { mergeGs1 } from "@/lib/receiving/gs1";
import { parseDay } from "@/lib/receiving/dates";
import { formPhotos, storePhoto, type StoredPhoto } from "@/lib/receiving/photos";
import { readCaseLabel, readProductDate } from "@/lib/receiving/vision";
import { isCondition } from "@/lib/receiving/conditions";
import { labelReaderConfigured } from "@/lib/config";

function text(form: FormData, key: string): string | null {
  const v = String(form.get(key) ?? "").trim();
  return v || null;
}

function withMsg(path: string, kind: "notice" | "error", m: string) {
  return `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(m)}`;
}

function barcodesFrom(form: FormData, index: number): string[] {
  try {
    const all = JSON.parse(String(form.get("barcodes") ?? "[]"));
    const mine = Array.isArray(all) ? all[index] : null;
    return Array.isArray(mine) ? mine.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  } catch {
    return [];
  }
}

export async function createDelivery(form: FormData) {
  const d = await prisma.receivingDelivery.create({
    data: {
      supplier: text(form, "supplier") ?? "GFS",
      invoiceNumber: text(form, "invoiceNumber"),
      receivedBy: text(form, "receivedBy"),
      notes: text(form, "notes"),
    },
  });
  redirect(`/admin/receiving/${d.id}`);
}

export async function updateDelivery(form: FormData) {
  const id = String(form.get("id"));
  await prisma.receivingDelivery.update({
    where: { id },
    data: {
      supplier: text(form, "supplier") ?? "GFS",
      invoiceNumber: text(form, "invoiceNumber"),
      receivedBy: text(form, "receivedBy"),
      notes: text(form, "notes"),
    },
  });
  revalidatePath("/admin/receiving", "layout");
  redirect(withMsg(`/admin/receiving/${id}`, "notice", "Delivery saved."));
}

export async function deleteDelivery(form: FormData) {
  await prisma.receivingDelivery.delete({ where: { id: String(form.get("id")) } });
  revalidatePath("/admin/receiving", "layout");
  redirect(withMsg("/admin/receiving", "notice", "Delivery deleted."));
}

/** Builds one case record from one sticker photo: phone-decoded barcodes first, then the photo reader. */
async function caseFromLabel(deliveryId: string, photo: StoredPhoto, barcodes: string[]) {
  const gs1 = mergeGs1(barcodes);
  const plainGtin = barcodes.find((b) => /^\d{12,13}$/.test(b))?.padStart(14, "0");
  const read = labelReaderConfigured() ? await readCaseLabel(photo) : null;
  const r = read?.ok ? read.reading : null;

  const labelExpiry = gs1?.expiry ?? gs1?.bestBefore ?? gs1?.sellBy ?? r?.expiryDate ?? null;
  const expiryDate = parseDay(labelExpiry);
  return prisma.receivedCase.create({
    data: {
      deliveryId,
      itemCode: r?.itemCode ?? null,
      description: r?.description ?? null,
      brand: r?.brand ?? null,
      packSize: r?.packSize ?? null,
      gtin: gs1?.gtin ?? plainGtin ?? r?.gtin ?? null,
      lotCode: gs1?.lot ?? r?.lotCode ?? null,
      packDate: parseDay(gs1?.packDate ?? gs1?.productionDate ?? r?.packDate),
      expiryDate,
      expirySource: expiryDate ? "LABEL" : null,
      expiryRawText: expiryDate ? (r?.expiryRawText ?? null) : null,
      labelText: r?.labelText ?? null,
      barcodesJson: barcodes.length ? JSON.stringify(barcodes) : null,
      extractionJson: r || gs1 ? JSON.stringify({ reader: r, gs1 }) : null,
      extractionError: read && !read.ok ? read.error : null,
      photos: { create: { kind: "LABEL", fileName: photo.fileName, mimeType: photo.mimeType, sizeBytes: photo.sizeBytes } },
    },
  });
}

/** One or more case-sticker photos -> one case each. A single photo opens that case so its expiry can be added. */
export async function scanLabels(form: FormData) {
  const deliveryId = String(form.get("deliveryId"));
  const back = `/admin/receiving/${deliveryId}`;
  const files = formPhotos(form);
  if (!files.length) redirect(withMsg(back, "error", "No photo received."));

  let created: { id: string; extractionError: string | null }[];
  try {
    const stored = await Promise.all(files.map(storePhoto));
    created = await Promise.all(stored.map((p, i) => caseFromLabel(deliveryId, p, barcodesFrom(form, i))));
  } catch (e) {
    redirect(withMsg(back, "error", e instanceof Error ? e.message : String(e)));
  }
  revalidatePath("/admin/receiving", "layout");

  const failed = created.filter((c) => c.extractionError).length;
  if (created.length === 1) {
    const c = created[0];
    const note = c.extractionError
      ? `Photo saved, but the sticker couldn't be read (${c.extractionError}). Fill in the fields below.`
      : labelReaderConfigured()
        ? "Sticker read. Check the fields, then add the expiry date."
        : "Photo saved. Type the sticker details and expiry date.";
    redirect(withMsg(`/admin/receiving/cases/${c.id}`, c.extractionError ? "error" : "notice", note));
  }
  redirect(withMsg(back, failed ? "error" : "notice", `${created.length} boxes added${failed ? `; ${failed} sticker(s) couldn't be read — open them to fill in` : ""}.`));
}

export async function addManualCase(form: FormData) {
  const deliveryId = String(form.get("deliveryId"));
  const c = await prisma.receivedCase.create({ data: { deliveryId } });
  redirect(`/admin/receiving/cases/${c.id}`);
}

export async function saveCase(form: FormData) {
  const id = String(form.get("id"));
  const before = await prisma.receivedCase.findUniqueOrThrow({ where: { id } });
  const expiryDate = parseDay(text(form, "expiryDate"));
  const expiryChanged = (expiryDate?.getTime() ?? null) !== (before.expiryDate?.getTime() ?? null);
  const rawCondition = String(form.get("condition") ?? "OK");
  const condition = isCondition(rawCondition) ? rawCondition : "OK";
  const quantity = Math.max(1, Number(form.get("quantity")) || 1);
  const issueQty = Number(form.get("issueQuantity"));

  await prisma.receivedCase.update({
    where: { id },
    data: {
      itemCode: text(form, "itemCode"),
      description: text(form, "description"),
      brand: text(form, "brand"),
      packSize: text(form, "packSize"),
      gtin: text(form, "gtin"),
      lotCode: text(form, "lotCode"),
      packDate: parseDay(text(form, "packDate")),
      expiryDate,
      // A hand-edited date is a manual entry; an untouched one keeps where it came from.
      expirySource: !expiryDate ? null : expiryChanged ? "MANUAL" : before.expirySource,
      expiryRawText: expiryChanged ? null : before.expiryRawText,
      quantity,
      condition,
      issueQuantity: condition !== "OK" && issueQty > 0 ? Math.min(issueQty, quantity) : null,
      issueNote: condition !== "OK" ? text(form, "issueNote") : null,
    },
  });
  revalidatePath("/admin/receiving", "layout");
  if (form.get("next") === "1") redirect(withMsg(`/admin/receiving/${before.deliveryId}`, "notice", "Saved. Snap the next box."));
  redirect(withMsg(`/admin/receiving/cases/${id}`, "notice", "Saved."));
}

/** Photo of the product's printed date -> expiry date on the case. */
export async function scanExpiry(form: FormData) {
  const id = String(form.get("caseId"));
  const back = `/admin/receiving/cases/${id}`;
  const file = formPhotos(form)[0];
  if (!file) redirect(withMsg(back, "error", "No photo received."));

  let result: { kind: "notice" | "error"; msg: string };
  try {
    const photo = await storePhoto(file);
    await prisma.receivingPhoto.create({
      data: { caseId: id, kind: "EXPIRY", fileName: photo.fileName, mimeType: photo.mimeType, sizeBytes: photo.sizeBytes },
    });
    if (!labelReaderConfigured()) {
      result = { kind: "notice", msg: "Date photo saved. Type the date in Expiry date." };
    } else {
      const read = await readProductDate(photo);
      const expiryDate = read.ok ? parseDay(read.reading.expiryDate) : null;
      if (read.ok && expiryDate) {
        const r = read.reading;
        await prisma.receivedCase.update({
          where: { id },
          data: { expiryDate, expirySource: "PHOTO", expiryRawText: [r.dateLabel, r.rawText].filter(Boolean).join(" ") || null },
        });
        result = {
          kind: r.confidence === "high" ? "notice" : "error",
          msg: `Expiry read as ${read.reading.rawText ?? read.reading.expiryDate}${r.confidence === "high" ? "." : ` (${r.confidence} confidence — please check it).`}${r.notes ? ` ${r.notes}` : ""}`,
        };
      } else {
        const why = read.ok ? (read.reading.notes ?? "no date found") : read.error;
        result = { kind: "error", msg: `Couldn't read a date from the photo (${why}). Type it in Expiry date.` };
      }
    }
  } catch (e) {
    result = { kind: "error", msg: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/admin/receiving", "layout");
  redirect(withMsg(back, result.kind, result.msg));
}

/** Condition evidence (mould, crushed boxes…) for a credit claim. */
export async function addConditionPhotos(form: FormData) {
  const id = String(form.get("caseId"));
  const files = formPhotos(form);
  const stored = await Promise.all(files.map(storePhoto));
  await prisma.receivingPhoto.createMany({
    data: stored.map((p) => ({ caseId: id, kind: "CONDITION", fileName: p.fileName, mimeType: p.mimeType, sizeBytes: p.sizeBytes })),
  });
  revalidatePath("/admin/receiving", "layout");
  redirect(withMsg(`/admin/receiving/cases/${id}`, "notice", `${stored.length} photo(s) added.`));
}

export async function deletePhoto(form: FormData) {
  const photo = await prisma.receivingPhoto.delete({ where: { id: String(form.get("photoId")) } });
  revalidatePath("/admin/receiving", "layout");
  redirect(`/admin/receiving/cases/${photo.caseId}`);
}

export async function deleteCase(form: FormData) {
  const c = await prisma.receivedCase.delete({ where: { id: String(form.get("id")) } });
  revalidatePath("/admin/receiving", "layout");
  redirect(withMsg(`/admin/receiving/${c.deliveryId}`, "notice", "Box removed."));
}
