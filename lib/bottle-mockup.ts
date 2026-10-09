// Mock-ups for the bottle finder: the logo printed onto the bottle in CJ's own product photo, not floated over it.
// We find the bottle in the photo (CJ studio shots sit on a plain light background), measure its body, wrap the
// logo around it as a cylinder and let the photo's own light and shadow fall across the print. Photos where we
// can't find exactly one bottle on a plain background (lifestyle shots, colour line-ups, collages) get no
// mock-up, and the finder leaves those listings out.

import sharp from "sharp";
import { processSingleton } from "@/lib/singleton";

const SIZE = 900; // working and output size (longest side)

export interface BottleFit {
  /** Body centre and width, and the print area's vertical centre and height limit, in output pixels. */
  cx: number;
  cy: number;
  bodyW: number;
  maxH: number;
}

interface Analysed {
  fit: BottleFit | null;
  photo: Buffer | null; // the source photo, resized (JPEG), kept for rendering
}

const analysed = processSingleton("bottle-fit", () => new Map<string, Analysed>());
const rendered = processSingleton("bottle-mock", () => new Map<string, Buffer>());
const logos = processSingleton("bottle-logos", () => new Map<string, Promise<{ data: Buffer; w: number; h: number }>>());
const MAX_ANALYSED = 400;
const MAX_RENDERED = 200;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Where the bottle's body is in an RGB image, or null when the photo isn't one bottle on a plain background. */
export function findBottle(px: Uint8Array | Buffer, w: number, h: number): BottleFit | null {
  const at = (x: number, y: number) => (y * w + x) * 3;
  // Background: the four corners must agree, be flat and light.
  const p = Math.max(6, Math.round(Math.min(w, h) * 0.03));
  const patches = [
    [0, 0],
    [w - p, 0],
    [0, h - p],
    [w - p, h - p],
  ].map(([x0, y0]) => {
    const vals: number[][] = [[], [], []];
    for (let y = y0; y < y0 + p; y++) for (let x = x0; x < x0 + p; x++) for (let c = 0; c < 3; c++) vals[c].push(px[at(x, y) + c]);
    const mean = vals.map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    const sd = Math.max(...vals.map((v, c) => Math.sqrt(v.reduce((a, b) => a + (b - mean[c]) ** 2, 0) / v.length)));
    return { mean, sd };
  });
  const bg = [0, 1, 2].map((c) => median(patches.map((q) => q.mean[c])));
  const dist = (m: number[]) => Math.hypot(m[0] - bg[0], m[1] - bg[1], m[2] - bg[2]);
  if (patches.some((q) => q.sd > 14 || dist(q.mean) > 28)) return null;
  if ((bg[0] + bg[1] + bg[2]) / 3 < 165) return null;

  // Foreground: everything that differs from the background, plus enclosed areas that aren't exactly background
  // (shine and white labels on the bottle). The background seen through a handle stays a hole.
  const diff = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) diff[i] = Math.min(255, Math.hypot(px[j] - bg[0], px[j + 1] - bg[1], px[j + 2] - bg[2]));
  const fg = diff.map((d) => (d > 16 ? 1 : 0));
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (outside[i] || fg[i]) continue;
    outside[i] = 1;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i < w * (h - 1)) stack.push(i + w);
  }
  // Runs per row (gaps of a few pixels bridged).
  const gap = Math.max(3, Math.round(w * 0.006));
  const runs: Array<Array<[number, number]>> = [];
  let area = 0;
  for (let y = 0; y < h; y++) {
    const row: Array<[number, number]> = [];
    let start = -1;
    let last = -1;
    for (let x = 0; x < w; x++) {
      if (outside[y * w + x] || (!fg[y * w + x] && diff[y * w + x] <= 6)) continue;
      area++;
      if (start < 0) start = x;
      else if (x - last > gap) {
        row.push([start, last]);
        start = x;
      }
      last = x;
    }
    if (start >= 0) row.push([start, last]);
    // A thin gap between two substantial pieces is a reflection streak on the bottle, not the space between two things.
    const merged: Array<[number, number]> = [];
    for (const r of row) {
      const prev = merged[merged.length - 1];
      const g = prev ? r[0] - prev[1] : Infinity;
      const a = prev ? prev[1] - prev[0] : 0;
      const b = r[1] - r[0];
      // (A handle is a thin piece beside the body, so it stays separate.)
      if (prev && g <= w * 0.04 && g <= 0.2 * Math.max(a, b) && Math.min(a, b) >= 0.15 * Math.max(a, b)) prev[1] = r[1];
      else merged.push([r[0], r[1]]);
    }
    runs.push(merged);
  }
  const frac = area / (w * h);
  if (frac < 0.04 || frac > 0.8) return null;

  const minRun = w * 0.08;
  const fgRows = runs.map((r, y) => (r.some(([a, b]) => b - a >= minRun) ? y : -1)).filter((y) => y >= 0);
  if (fgRows.length < h * 0.25) return null;
  const top = fgRows[0];
  const bottom = fgRows[fgRows.length - 1];
  const tall = bottom - top;

  // The middle of the product: exactly one wide run per row (more means several bottles side by side).
  const band: Array<{ y: number; l: number; r: number }> = [];
  const counts: number[] = [];
  for (let y = Math.round(top + tall * 0.3); y <= top + tall * 0.85; y++) {
    const wide = runs[y].filter(([a, b]) => b - a >= minRun);
    counts.push(wide.length);
    if (wide.length === 1) band.push({ y, l: wide[0][0], r: wide[0][1] });
  }
  if (median(counts) !== 1 || band.length < counts.length * 0.7) return null;
  const bodyW = median(band.map((b) => b.r - b.l));
  const cx = median(band.map((b) => (b.l + b.r) / 2));
  if (bodyW < w * 0.14 || bodyW > w * 0.9) return null;
  // The product must be roughly centred and not cut off by the frame.
  if (cx < w * 0.25 || cx > w * 0.75 || top < 2 || bottom > h - 3) return null;

  // The straight part of the body: the rows whose width is close to the typical width.
  const body = band.filter((b) => Math.abs(b.r - b.l - bodyW) <= bodyW * 0.12 && Math.abs((b.l + b.r) / 2 - cx) <= bodyW * 0.1);
  if (body.length < tall * 0.15) return null;
  const y0 = body[0].y;
  const y1 = body[body.length - 1].y;
  return { cx, cy: (y0 + y1) / 2, bodyW, maxH: (y1 - y0) * 0.7 };
}

async function loadPhoto(url: string): Promise<{ jpeg: Buffer; raw: Buffer; w: number; h: number } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok || !(res.headers.get("content-type") || "").startsWith("image/")) return null;
    const img = sharp(Buffer.from(await res.arrayBuffer()))
      .rotate()
      .resize(SIZE, SIZE, { fit: "inside", withoutEnlargement: false })
      .flatten({ background: "#ffffff" });
    const jpeg = await img.clone().jpeg({ quality: 90 }).toBuffer();
    const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { jpeg, raw: data, w: info.width, h: info.height };
  } catch {
    return null;
  }
}

/** Downloads and measures a listing's photo once; true when a mock-up can be drawn on it. */
export async function analyseBottle(pid: string, imageUrl: string): Promise<boolean> {
  const hit = analysed.get(pid);
  if (hit) return !!hit.fit;
  const photo = await loadPhoto(imageUrl);
  const fit = photo ? findBottle(photo.raw, photo.w, photo.h) : null;
  if (analysed.size >= MAX_ANALYSED) analysed.delete(analysed.keys().next().value!);
  analysed.set(pid, { fit, photo: fit ? photo!.jpeg : null });
  return !!fit;
}

function logo(file: string) {
  let p = logos.get(file);
  if (!p) {
    p = sharp(`${process.cwd()}/public/brand/print/${file}`)
      .trim()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => ({ data, w: info.width, h: info.height }));
    logos.set(file, p);
  }
  return p;
}

/** The listing's photo with the logo printed on the bottle (JPEG), or null if it was never measured or doesn't fit. */
export async function bottleMockup(pid: string, logoFile: string): Promise<Buffer | null> {
  const key = `${pid}|${logoFile}`;
  const done = rendered.get(key);
  if (done) return done;
  const a = analysed.get(pid);
  if (!a?.fit || !a.photo) return null;
  const { cx, cy, bodyW, maxH } = a.fit;
  const { data: photo, info } = await sharp(a.photo).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  // Light on the bottle where the print sits: the median brightness across the middle of the body.
  const lum = (i: number) => 0.299 * photo[i] + 0.587 * photo[i + 1] + 0.114 * photo[i + 2];
  const sample: number[] = [];
  for (let y = Math.round(cy - maxH / 2); y < cy + maxH / 2; y += 3)
    for (let x = Math.round(cx - bodyW * 0.3); x < cx + bodyW * 0.3; x += 3) if (x >= 0 && y >= 0 && x < W && y < H) sample.push(lum((y * W + x) * 3));
  const ref = Math.max(20, median(sample));
  // Dark lettering disappears on a dark bottle; print the light version there, as you would order it.
  const art = await logo(ref < 95 && logoFile === "chit-logo-dark.png" ? "chit-logo-light.png" : logoFile);

  // The print covers this share of the visible body width, wrapped round the cylinder.
  const half = bodyW / 2;
  const span = 0.62; // fraction of the half-width the print reaches at its edges
  const phiMax = Math.asin(span);
  // Height from the artwork's proportions at its unwrapped width (arc length), capped to the straight body.
  const unwrappedW = 2 * phiMax * half;
  let printH = (unwrappedW * art.h) / art.w;
  let scale = 1;
  if (printH > maxH) {
    scale = maxH / printH;
    printH = maxH;
  }
  const phiEdge = phiMax * scale; // a shorter print is narrower too
  const x0 = Math.floor(cx - Math.sin(phiEdge) * half);
  const x1 = Math.ceil(cx + Math.sin(phiEdge) * half);
  const y0 = Math.floor(cy - printH / 2);
  const y1 = Math.ceil(cy + printH / 2);


  const out = Buffer.from(photo);
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    const v = (y - (cy - printH / 2)) / printH;
    if (v < 0 || v >= 1) continue;
    const sy = Math.min(art.h - 1, Math.floor(v * art.h));
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const nx = (x + 0.5 - cx) / half;
      if (Math.abs(nx) >= 1) continue;
      const u = (Math.asin(nx) / phiEdge + 1) / 2;
      if (u < 0 || u >= 1) continue;
      const si = (sy * art.w + Math.min(art.w - 1, Math.floor(u * art.w))) * 4;
      // Ink fades a little where the surface turns away.
      const alpha = (art.data[si + 3] / 255) * 0.96 * Math.min(1, Math.sqrt(1 - nx * nx) * 1.6);
      if (alpha <= 0.01) continue;
      const pi = (y * W + x) * 3;
      const l = lum(pi);
      const shade = Math.min(1.3, Math.max(0.45, l / ref));
      const glint = Math.max(0, l - ref * 1.15) * 0.6; // specular highlights stay on top of the print
      for (let c = 0; c < 3; c++) {
        const ink = Math.min(255, art.data[si + c] * shade + glint);
        out[pi + c] = Math.round(out[pi + c] * (1 - alpha) + ink * alpha);
      }
    }
  }
  const jpeg = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  if (rendered.size >= MAX_RENDERED) rendered.delete(rendered.keys().next().value!);
  rendered.set(key, jpeg);
  return jpeg;
}
