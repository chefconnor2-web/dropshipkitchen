"use client";

// The print-on-demand designer: the shopper picks a photo (or types text), sees it on the product, drags and
// zooms it into place, and adds it to the cart. Everything is drawn in the browser: the print file CJ prints
// (at the merchant's print size) and a mock-up for the merchant's review are uploaded with the order line.

import { useEffect, useRef, useState } from "react";
import { coverRect, type DesignerConfig } from "@/lib/personalize-shared";

const FONTS = [
  { id: "bold", label: "Bold", css: '800 {px}px "Arial Black", "Helvetica Neue", Arial, sans-serif' },
  { id: "serif", label: "Classic", css: '700 {px}px Georgia, "Times New Roman", serif' },
  { id: "script", label: "Script", css: 'italic 600 {px}px "Brush Script MT", "Segoe Script", cursive' },
  { id: "mono", label: "Type", css: '700 {px}px "Courier New", Courier, monospace' },
] as const;
const COLORS = ["#111111", "#ffffff", "#c8102e", "#0b3d91", "#1f7a3a", "#d4a017"];
const PREVIEW_PX = 900;

type Mode = "photo" | "text";
export type AddResult = { ok: boolean; message: string; cartCount?: number };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn’t open that picture."));
    img.src = src;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn’t render the design."))), type, quality));
}

export default function Personalizer({
  config: cfg,
  imageSrc,
  variantId,
  disabled,
  photos = [],
  onAdded,
}: {
  config: DesignerConfig;
  /** The product photo the mock-up is drawn on (same-origin /media URL). */
  imageSrc: string | null;
  variantId: string | null;
  disabled?: boolean;
  /** Photos the shopper already shared (e.g. in the chat), offered as one-tap choices. */
  photos?: string[];
  onAdded?: (r: AddResult) => void;
}) {
  const [mode, setMode] = useState<Mode>(cfg.allowPhoto ? "photo" : "text");
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const [text, setText] = useState("");
  const [font, setFont] = useState<(typeof FONTS)[number]["id"]>("bold");
  const [color, setColor] = useState(COLORS[0]);
  const [quantity, setQuantity] = useState(1);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddResult | null>(null);
  const [base, setBase] = useState<HTMLImageElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    setBase(null);
    if (imageSrc) loadImage(imageSrc).then((img) => live && setBase(img)).catch(() => null);
    return () => {
      live = false;
    };
  }, [imageSrc]);

  const hasDesign = mode === "photo" ? !!photo : text.trim().length > 0;
  const lowRes = mode === "photo" && photo ? Math.min(photo.naturalWidth / cfg.artWidth, photo.naturalHeight / cfg.artHeight) * zoom < 0.5 : false;

  /** Draws the design at w×h: the photo cropped to fill, or the text as large as fits. */
  function drawArt(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.clearRect(0, 0, w, h);
    if (mode === "photo" && photo) {
      const r = coverRect(photo.naturalWidth, photo.naturalHeight, w, h, zoom, offset.dx, offset.dy);
      ctx.drawImage(photo, r.x, r.y, r.w, r.h);
    } else if (mode === "text" && text.trim()) {
      const css = FONTS.find((f) => f.id === font)!.css;
      const lines = text.trim().split(/\n/).slice(0, 3);
      let px = h / lines.length / 1.25;
      ctx.font = css.replace("{px}", String(px));
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
      if (widest > w * 0.92) px *= (w * 0.92) / widest;
      ctx.font = css.replace("{px}", String(px));
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const lh = px * 1.2;
      lines.forEach((l, i) => ctx.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * lh));
    }
  }

  function artCanvas(scale: number) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(cfg.artWidth * scale));
    c.height = Math.max(1, Math.round(cfg.artHeight * scale));
    drawArt(c.getContext("2d")!, c.width, c.height);
    return c;
  }

  /** The mock-up: the product photo with the design fitted into the merchant's print area. */
  function drawPreview(target: HTMLCanvasElement) {
    const bw = base?.naturalWidth || 1000;
    const bh = base?.naturalHeight || 1000;
    target.width = PREVIEW_PX;
    target.height = Math.round((PREVIEW_PX * bh) / bw);
    const ctx = target.getContext("2d")!;
    ctx.fillStyle = "#f1efea";
    ctx.fillRect(0, 0, target.width, target.height);
    if (base) ctx.drawImage(base, 0, 0, target.width, target.height);
    const box = { x: cfg.box.x * target.width, y: cfg.box.y * target.height, w: cfg.box.w * target.width, h: cfg.box.h * target.height };
    if (hasDesign) {
      const art = artCanvas(Math.min(1, (box.w * 2) / cfg.artWidth));
      const s = Math.min(box.w / art.width, box.h / art.height);
      const w = art.width * s;
      const h = art.height * s;
      ctx.drawImage(art, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
    } else {
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
    }
  }

  useEffect(() => {
    if (canvas.current) drawPreview(canvas.current);
  });

  // A new design (or option) clears the last "added" message so it isn't mistaken for this one.
  useEffect(() => setResult(null), [mode, text, font, color, variantId]);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return setResult({ ok: false, message: "Choose a photo (JPEG or PNG)." });
    const url = URL.createObjectURL(file);
    try {
      choosePhoto(await loadImage(url));
      URL.revokeObjectURL(url);
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Couldn’t open that photo." });
    }
  }

  function choosePhoto(img: HTMLImageElement) {
    setPhoto(img);
    setZoom(1);
    setOffset({ dx: 0, dy: 0 });
    setResult(null);
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (mode !== "photo" || !photo) return;
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drag.current || !photo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const boxW = cfg.box.w * rect.width;
    const boxH = cfg.box.h * rect.height;
    const r = coverRect(photo.naturalWidth, photo.naturalHeight, boxW, boxH, zoom);
    const slackX = (r.w - boxW) / 2 || 1;
    const slackY = (r.h - boxH) / 2 || 1;
    const mx = e.clientX - drag.current.x;
    const my = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setOffset((o) => ({ dx: Math.max(-1, Math.min(1, o.dx - mx / slackX)), dy: Math.max(-1, Math.min(1, o.dy - my / slackY)) }));
  }

  async function add() {
    if (!variantId || !hasDesign || !agreed || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const art = artCanvas(1);
      // Photos print from a high-quality JPEG; text keeps a transparent background as PNG.
      let artBlob = mode === "photo" ? await toBlob(art, "image/jpeg", 0.92) : await toBlob(art, "image/png");
      if (artBlob.size > 11 * 1024 * 1024) artBlob = await toBlob(art, "image/jpeg", 0.8);
      const prev = document.createElement("canvas");
      drawPreview(prev);
      const previewBlob = await toBlob(prev, "image/jpeg", 0.85);
      const form = new FormData();
      form.set("variantId", variantId);
      form.set("quantity", String(quantity));
      form.set("kind", mode);
      form.set("text", mode === "text" ? text.trim() : "");
      form.set("art", artBlob, mode === "photo" ? "art.jpg" : "art.png");
      form.set("preview", previewBlob, "preview.jpg");
      const r = await fetch("/api/personalize", { method: "POST", body: form });
      const d = (await r.json().catch(() => ({}))) as AddResult;
      const out = { ok: !!d.ok, message: d.message || (d.ok ? "Added to your cart." : "Couldn’t add that. Please try again."), cartCount: d.cartCount };
      setResult(out);
      if (out.ok) setAgreed(false);
      onAdded?.(out);
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Couldn’t add that. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pz">
      <div className="pz-head">
        <strong>Make it yours</strong>
        {cfg.allowPhoto && cfg.allowText && (
          <div className="pz-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "photo"} className={mode === "photo" ? "on" : ""} onClick={() => setMode("photo")}>
              Photo
            </button>
            <button type="button" role="tab" aria-selected={mode === "text"} className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>
              Text
            </button>
          </div>
        )}
      </div>
      {cfg.instructions && <p className="pz-note">{cfg.instructions}</p>}

      <canvas
        ref={canvas}
        className={`pz-canvas${mode === "photo" && photo ? " pz-draggable" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        aria-label="Preview of your design on the product"
        role="img"
      />

      {mode === "photo" ? (
        <div className="pz-controls">
          <label className="btn pz-upload">
            {photo ? "Change photo" : "Upload a photo"}
            <input type="file" accept="image/*" onChange={(e) => pickFile(e.target.files?.[0])} hidden />
          </label>
          {photos.length > 0 && (
            <div className="pz-photos" aria-label="Photos you shared">
              {photos.map((src) => (
                <button key={src} type="button" onClick={() => loadImage(src).then(choosePhoto).catch(() => null)} title="Use this photo">
                  <img src={src} alt="" />
                </button>
              ))}
            </div>
          )}
          {photo && (
            <label className="pz-zoom">
              Zoom
              <input type="range" min={1} max={3} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
            </label>
          )}
          {photo && <p className="pz-hint">Drag the picture to move it.</p>}
          {lowRes && <p className="pz-warn">This photo is small, so it may print blurry. A larger photo will look sharper.</p>}
        </div>
      ) : (
        <div className="pz-controls">
          <label>
            Your text
            <textarea rows={2} maxLength={cfg.maxTextLength} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type your words" />
            <span className="pz-count">
              {text.length}/{cfg.maxTextLength}
            </span>
          </label>
          <div className="pz-fonts" role="radiogroup" aria-label="Font">
            {FONTS.map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={font === f.id} className={font === f.id ? "on" : ""} onClick={() => setFont(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="pz-colors" role="radiogroup" aria-label="Colour">
            {COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={color === c ? "on" : ""} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
      )}

      <label className="pz-agree">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>I’ve checked the preview and spelling, and I have the right to use this picture. Personalized items are made for me and can’t be returned.</span>
      </label>
      <div className="pz-buy">
        <input className="qty" type="number" min={1} max={99} value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} aria-label="Quantity" />
        <button type="button" className="btn primary lg grow-btn" disabled={disabled || !variantId || !hasDesign || !agreed || busy} onClick={add}>
          {busy ? "Saving your design…" : "Add personalized item"}
        </button>
      </div>
      {result && (
        <p className={result.ok ? "notice ok" : "notice err"} role="status">
          {result.message} {result.ok && <a href="/cart">View cart →</a>}
        </p>
      )}
    </div>
  );
}
