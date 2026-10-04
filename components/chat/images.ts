"use client";
// Photos for the assistant: shrunk in the browser (long edge ≤ 1568px, the most Claude looks at) and
// uploaded as JPEG, so phone photos of 5-10 MB become ~300 KB and upload in a moment.

const MAX_EDGE = 1568;

async function decode(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { img: bmp, w: bmp.width, h: bmp.height };
  } catch {
    // Safari before 17 and some formats: fall back to an <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { img, w: img.naturalWidth, h: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export async function shrink(file: Blob): Promise<Blob> {
  const { img, w, h } = await decode(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // transparent PNGs get a white background, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn’t read that photo."))), "image/jpeg", 0.86));
}

export async function uploadImage(file: Blob): Promise<string> {
  const body = await shrink(file);
  const r = await fetch("/api/assistant/upload", { method: "POST", headers: { "content-type": "image/jpeg" }, body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error(d.error || "Upload failed.");
  return d.id as string;
}

export const imageUrl = (id: string) => `/api/assistant/image/${encodeURIComponent(id)}`;
