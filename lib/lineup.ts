// The Link line: our own DeWalt 20V MAX → Starlink Mini power products. They are being sourced
// through CJ (scripts/sourcing-requests.json) and show as "in testing" until samples pass, so
// nothing here is buyable yet and the prices are planned, not live.

export interface LinkProduct {
  id: string;
  name: string;
  summary: string;
  plannedPrice: number;
  /** Batteries the product holds, for the runtime shown on its card. */
  batteries: number;
  specs: Array<[label: string, value: string]>;
}

export const LINK_LINE: LinkProduct[] = [
  {
    id: "link-cable",
    name: "Link Cable",
    summary: "Battery adapter with a 2 m fused 18AWG cord that plugs straight into Starlink Mini.",
    plannedPrice: 39,
    batteries: 1,
    specs: [["Input", "20V MAX"], ["Cord", "2 m · 18AWG"], ["Protection", "Inline fuse"]],
  },
  {
    id: "link-dock",
    name: "Link Dock",
    summary: "Battery dock with a power switch and low-voltage cutoff, so a pack is never run flat.",
    plannedPrice: 59,
    batteries: 1,
    specs: [["Control", "Power switch"], ["Protection", "Low-voltage cutoff"], ["Lead", "0.3 m"]],
  },
  {
    id: "link-dual",
    name: "Link Dual",
    summary: "Weatherproof case for two batteries, with a switch and DC plug, for a full day online.",
    plannedPrice: 129,
    batteries: 2,
    specs: [["Input", "2 × 20V MAX"], ["Case", "Weatherproof"], ["Output", "Switch + DC plug"]],
  },
  {
    id: "basecamp-kit",
    name: "Basecamp Kit",
    summary: "Link Dual plus a dish mount, hard case and 5 m cable. Everything for a remote site.",
    plannedPrice: 219,
    batteries: 2,
    specs: [["Includes", "Link Dual"], ["Mount", "Dish mount"], ["Case", "Hard case · 5 m cable"]],
  },
];

/** Battery choices for the runtime calculator: 20V MAX packs are 18V nominal. */
export const BATTERY_AH = [2, 4, 5, 6, 8, 12] as const;
export const NOMINAL_VOLTS = 18;
/** Starlink Mini draw: ~17W steady on 2026 firmware, ~25W typical, up to 40W under load. */
export const DRAW_WATTS = { light: 17, typical: 25, heavy: 40 } as const;

/** Hours online ≈ battery Wh × 0.9 (conversion losses) ÷ draw. */
export function runtimeHours(ah: number, batteries: number, watts: number): number {
  return (NOMINAL_VOLTS * ah * batteries * 0.9) / watts;
}
