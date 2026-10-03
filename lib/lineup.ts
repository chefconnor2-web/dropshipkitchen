// The Link line: our own tool-battery → Starlink Mini power products, one version per battery platform.
// They are being sourced through CJ (scripts/sourcing-requests*.json) and show as "in testing" until
// samples pass, so nothing here is buyable yet and the prices are planned, not live.
// CJ sourcing ids: DeWalt 2610030439044496502, …054499400, …074502102, …084505000; Milwaukee dock 2610032251094495102.
// Still to submit (CJ allows a few a day): scripts/sourcing-requests-platforms.json.

export type PlatformId = "dewalt" | "milwaukee" | "makita" | "ryobi" | "bosch";

export interface BatteryPlatform {
  id: PlatformId;
  brand: string;
  /** The platform's own name for its pack system. */
  line: string;
  /** Nominal pack voltage; every supported platform is an 18V-class pack (20V MAX is 18V nominal). */
  nominalVolts: number;
  /** testing: samples requested from our supplier. next: on the roadmap, not requested yet. */
  status: "testing" | "next";
  /** Common packs, so a buyer can match what's in their truck. */
  packs: string[];
}

export const PLATFORMS: BatteryPlatform[] = [
  { id: "dewalt", brand: "DeWalt", line: "20V MAX", nominalVolts: 18, status: "testing", packs: ["DCB203", "DCB205", "DCB206", "DCB208", "DCB240"] },
  { id: "milwaukee", brand: "Milwaukee", line: "M18", nominalVolts: 18, status: "testing", packs: ["XC5.0", "XC6.0", "HO 8.0", "HO 12.0", "FORGE"] },
  { id: "makita", brand: "Makita", line: "18V LXT", nominalVolts: 18, status: "next", packs: ["BL1840B", "BL1850B", "BL1860B", "BL1880B"] },
  { id: "ryobi", brand: "Ryobi", line: "18V ONE+", nominalVolts: 18, status: "next", packs: ["PBP004", "PBP005", "PBP006", "PBP007", "ONE+ HP"] },
  { id: "bosch", brand: "Bosch", line: "18V", nominalVolts: 18, status: "next", packs: ["GBA18V40", "GBA18V80", "CORE18V 4.0", "CORE18V 8.0"] },
];

/** Packs we deliberately don't build for, and why: Starlink Mini takes 12–48V DC. */
export const UNSUPPORTED = [
  { name: "12V packs (M12, CXT, 12V MAX)", why: "Sag under 12V under load, below what Starlink Mini needs." },
  { name: "EGO 56V and other 56–60V packs", why: "Above Starlink Mini’s 48V maximum input." },
];

export const DEFAULT_PLATFORM: PlatformId = "dewalt";

export function platformById(id: string | undefined | null): BatteryPlatform {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS.find((p) => p.id === DEFAULT_PLATFORM)!;
}

export const platformName = (p: BatteryPlatform) => `${p.brand} ${p.line}`;

export interface LinkProduct {
  id: string;
  name: string;
  summary: string;
  plannedPrice: number;
  /** Batteries the product holds, for the runtime shown on its card. */
  batteries: number;
  specs: Array<[label: string, value: string]>;
  /** Platforms this product is being built for. */
  fits: PlatformId[];
}

export const LINK_LINE: LinkProduct[] = [
  {
    id: "link-cable",
    name: "Link Cable",
    summary: "Battery adapter with a fused 18AWG cord that plugs straight into Starlink Mini.",
    plannedPrice: 39,
    batteries: 1,
    specs: [["Cord", "1 m · 18AWG"], ["Protection", "Inline fuse"]],
    fits: ["dewalt", "milwaukee", "makita", "ryobi", "bosch"],
  },
  {
    id: "link-dock",
    name: "Link Dock",
    summary: "Battery dock with a power switch and low-voltage cutoff, so a pack is never run flat.",
    plannedPrice: 59,
    batteries: 1,
    specs: [["Control", "Power switch"], ["Protection", "Low-voltage cutoff"]],
    fits: ["dewalt", "milwaukee"],
  },
  {
    id: "link-dual",
    name: "Link Dual",
    summary: "Weatherproof case for two batteries, with a switch and DC plug, for a full day online.",
    plannedPrice: 129,
    batteries: 2,
    specs: [["Case", "Weatherproof"], ["Output", "Switch + DC plug"]],
    fits: ["dewalt", "milwaukee"],
  },
  {
    id: "basecamp-kit",
    name: "Basecamp Kit",
    summary: "Link Dual plus a dish mount, hard case and 5 m cable. Everything for a remote site.",
    plannedPrice: 219,
    batteries: 2,
    specs: [["Includes", "Link Dual"], ["Mount", "Dish mount · 5 m cable"]],
    fits: ["dewalt", "milwaukee"],
  },
];

export function linkProductById(id: string | undefined | null): LinkProduct | undefined {
  return LINK_LINE.find((p) => p.id === id);
}

/** Battery choices for the runtime calculator. */
export const BATTERY_AH = [2, 4, 5, 6, 8, 12] as const;
/** Every supported platform is an 18V-nominal pack. */
export const NOMINAL_VOLTS = 18;
/** Starlink Mini draw: ~17W steady on 2026 firmware, ~25W typical, up to 40W under load. */
export const DRAW_WATTS = { light: 17, typical: 25, heavy: 40 } as const;

/** Hours online ≈ battery Wh × 0.9 (conversion losses) ÷ draw. */
export function runtimeHours(ah: number, batteries: number, watts: number): number {
  return (NOMINAL_VOLTS * ah * batteries * 0.9) / watts;
}
