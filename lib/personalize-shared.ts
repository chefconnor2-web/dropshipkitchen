// Print-on-demand personalization: the merchant's per-product set-up and the podProperties CJ expects.
// Pure and browser-safe: the storefront designer, the admin, checkout and fulfilment all use it.
//
// CJ prints the shopper's artwork on its POD products. The order line carries `podProperties`, a JSON
// string of at most 500 characters:
//   POD 2.0  [{"areaName":"LogoArea","links":["<artwork URL>"],"type":"1"}]
//   POD 3.0  [{"links":["<production image URL>"],"effectImgs":["<mock-up URL>"]}]
// Text designs are rendered to an image in the browser, so CJ always receives an image.

export type PodVersion = 2 | 3;

/** A rectangle as fractions (0-1) of the product photo: where the print lands on the mock-up. */
export interface PrintBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PersonalizeConfig {
  podVersion: PodVersion;
  /** CJ's name for the print area (POD 2.0), e.g. "LogoArea". */
  areaName: string;
  allowPhoto: boolean;
  allowText: boolean;
  maxTextLength: number;
  /** Size of the production artwork CJ prints, in pixels. */
  artWidth: number;
  artHeight: number;
  box: PrintBox;
  /** Shown to shoppers above the designer, e.g. "Square photos work best." */
  instructions: string;
}

/** What the shopper's designer needs: the set-up without CJ's own terms (kept off the storefront). */
export type DesignerConfig = Omit<PersonalizeConfig, "podVersion" | "areaName">;

export function designerConfig(c: PersonalizeConfig | null): DesignerConfig | null {
  if (!c) return null;
  const { podVersion: _v, areaName: _a, ...rest } = c;
  return rest;
}

export const POD_PROPERTIES_MAX = 500;

export const DEFAULT_PERSONALIZE: PersonalizeConfig = {
  podVersion: 2,
  areaName: "LogoArea",
  allowPhoto: true,
  allowText: true,
  maxTextLength: 40,
  artWidth: 2000,
  artHeight: 2000,
  box: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
  instructions: "",
};

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

/** The product's set-up, or null when it isn't personalizable (or the JSON is unusable). */
export function parsePersonalizeConfig(json: string | null | undefined): PersonalizeConfig | null {
  if (!json) return null;
  let raw: Partial<PersonalizeConfig> & { box?: Partial<PrintBox> };
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  return normalizeConfig(raw);
}

export function normalizeConfig(raw: Partial<PersonalizeConfig> & { box?: Partial<PrintBox> }): PersonalizeConfig | null {
  const d = DEFAULT_PERSONALIZE;
  const x = clamp(raw.box?.x, 0, 0.95, d.box.x);
  const y = clamp(raw.box?.y, 0, 0.95, d.box.y);
  const cfg: PersonalizeConfig = {
    podVersion: Number(raw.podVersion) === 3 ? 3 : 2,
    areaName: String(raw.areaName ?? d.areaName).trim().slice(0, 60) || d.areaName,
    allowPhoto: raw.allowPhoto !== false,
    allowText: raw.allowText !== false,
    maxTextLength: Math.round(clamp(raw.maxTextLength, 1, 200, d.maxTextLength)),
    artWidth: Math.round(clamp(raw.artWidth, 200, 6000, d.artWidth)),
    artHeight: Math.round(clamp(raw.artHeight, 200, 6000, d.artHeight)),
    box: { x, y, w: clamp(raw.box?.w, 0.05, 1 - x, d.box.w), h: clamp(raw.box?.h, 0.05, 1 - y, d.box.h) },
    instructions: String(raw.instructions ?? "").trim().slice(0, 300),
  };
  return cfg.allowPhoto || cfg.allowText ? cfg : null;
}

/** The podProperties string for one order line. Throws when the URLs make it longer than CJ accepts. */
export function buildPodProperties(p: { podVersion: number; areaName: string }, artUrl: string, previewUrl: string): string {
  const value =
    p.podVersion === 3
      ? JSON.stringify([{ links: [artUrl], effectImgs: [previewUrl] }])
      : JSON.stringify([{ areaName: p.areaName, links: [artUrl], type: "1" }]);
  if (value.length > POD_PROPERTIES_MAX)
    throw new Error(`The artwork links are too long for CJ (${value.length} of ${POD_PROPERTIES_MAX} characters). Use a shorter SITE_URL.`);
  return value;
}

/** Public artwork and mock-up URLs for a design, as CJ downloads them. */
export function podUrls(siteUrl: string, personalizationId: string) {
  const base = `${siteUrl.replace(/\/+$/, "")}/pod/${encodeURIComponent(personalizationId)}`;
  return { art: `${base}/art`, preview: `${base}/preview` };
}

/** Where `src` (w×h) is drawn to cover a box of bw×bh, zoomed and nudged (offsets -1..1 of the slack). */
export function coverRect(w: number, h: number, bw: number, bh: number, zoom = 1, dx = 0, dy = 0) {
  const scale = Math.max(bw / w, bh / h) * Math.max(1, zoom);
  const dw = w * scale;
  const dh = h * scale;
  const slackX = dw - bw;
  const slackY = dh - bh;
  const x = -slackX / 2 - (slackX / 2) * clamp(dx, -1, 1, 0);
  const y = -slackY / 2 - (slackY / 2) * clamp(dy, -1, 1, 0);
  return { x: x || 0, y: y || 0, w: dw, h: dh };
}
