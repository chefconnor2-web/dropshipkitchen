"use client";

import { useRef, useState, useTransition } from "react";

type Props = {
  action: (form: FormData) => Promise<void>;
  hidden: Record<string, string>;
  label: string;
  pendingText: string;
  /** Opens the rear camera straight away on phones. */
  camera?: boolean;
  multiple?: boolean;
  /** Decode the label's barcodes on the phone (Chrome/Android BarcodeDetector) and send them along. */
  scanBarcodes?: boolean;
  primary?: boolean;
};

const MAX_EDGE = 2400; // keeps small sticker print legible while staying well under upload limits

type Detector = { detect(src: ImageBitmap): Promise<{ rawValue: string }[]> };
type DetectorCtor = { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> };
const WANTED = ["code_128", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "data_matrix", "qr_code", "code_39"];

async function detector(): Promise<Detector | null> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const supported = await Ctor.getSupportedFormats();
    const formats = WANTED.filter((f) => supported.includes(f));
    return formats.length ? new Ctor({ formats }) : null;
  } catch {
    return null;
  }
}

/** Downscales to JPEG and reads barcodes; falls back to the original file if the browser can't decode it. */
async function prepare(file: File, scan: boolean): Promise<{ blob: Blob; name: string; codes: string[] }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { blob: file, name: file.name || "photo.jpg", codes: [] };
  }
  const codes: string[] = [];
  if (scan) {
    const d = await detector();
    if (d) {
      try {
        for (const r of await d.detect(bitmap)) if (r.rawValue && !codes.includes(r.rawValue)) codes.push(r.rawValue);
      } catch {
        /* barcode reading is a bonus; the photo still goes up */
      }
    }
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  return blob ? { blob, name: "photo.jpg", codes } : { blob: file, name: file.name || "photo.jpg", codes };
}

export function PhotoCapture({ action, hidden, label, pendingText, camera, multiple, scanBarcodes, primary }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const busy = pending || status !== null;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    setStatus(files.length > 1 ? `Preparing ${files.length} photos…` : "Preparing photo…");
    const form = new FormData();
    for (const [k, v] of Object.entries(hidden)) form.append(k, v);
    const barcodes: string[][] = [];
    for (const f of files) {
      const p = await prepare(f, !!scanBarcodes);
      form.append("photo", p.blob, p.name);
      barcodes.push(p.codes);
    }
    form.append("barcodes", JSON.stringify(barcodes));
    setStatus(files.length > 1 ? `${pendingText} (${files.length} photos)` : pendingText);
    startTransition(async () => {
      try {
        await action(form);
      } finally {
        setStatus(null);
      }
    });
  }

  return (
    <span className="capture">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture={camera ? "environment" : undefined}
        multiple={multiple}
        onChange={onPick}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
      />
      <button type="button" className={`btn${primary ? " primary" : ""} capture-btn`} disabled={busy} onClick={() => input.current?.click()}>
        {busy ? (status ?? pendingText) : label}
      </button>
    </span>
  );
}
