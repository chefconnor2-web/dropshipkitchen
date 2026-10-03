import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };

export type StoredPhoto = { fileName: string; mimeType: string; sizeBytes: number; data: Buffer };

/** Writes an uploaded photo to UPLOAD_DIR and returns its bytes so the label reader can use them without re-reading. */
export async function storePhoto(file: File): Promise<StoredPhoto> {
  const mimeType = file.type || "image/jpeg";
  if (!mimeType.startsWith("image/")) throw new Error(`Not an image: ${file.name} (${mimeType}).`);
  const data = Buffer.from(await file.arrayBuffer());
  const fileName = `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.${EXT[mimeType] ?? "img"}`;
  await mkdir(config.receiving.uploadDir, { recursive: true });
  await writeFile(path.join(config.receiving.uploadDir, fileName), data);
  return { fileName, mimeType, sizeBytes: data.length, data };
}

export async function readPhoto(fileName: string): Promise<Buffer> {
  // fileName comes from our own DB rows; basename() keeps a bad row from escaping the upload dir.
  return readFile(path.join(config.receiving.uploadDir, path.basename(fileName)));
}

/** Non-empty image files from a form field (a phone may submit an empty File when nothing was picked). */
export function formPhotos(form: FormData, field = "photo"): File[] {
  return form.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
}
