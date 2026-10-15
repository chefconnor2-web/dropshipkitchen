// Chit's product specialty: EV conversion, batteries and pack building, robotics, the electronics workbench and
// off-grid power. CURATED_PICKS (lib/curated-data.ts) are CJ products a buyer opened and judged against hard rules:
// physically consistent specs, named chips and models, real copper and nickel, a real description, and stock that
// can actually ship. Picks rank first in every search and carry their reason; listings with impossible claims are
// never shown.

import { CURATED_PICKS, type CuratedPick, type Sector } from "@/lib/curated-data";

export type { CuratedPick, Sector };
export { CURATED_PICKS };

export const SPECIALTY = "EV conversion, batteries and pack building, robotics, electronics workbench tools and off-grid power";

export const SECTORS: Record<Sector, string> = {
  ev: "EV conversion",
  batteries: "Batteries and pack building",
  robotics: "Robotics and maker electronics",
  tools: "Electronics workbench tools",
  power: "Off-grid power",
};

const byPid = new Map(CURATED_PICKS.map((p) => [p.pid, p]));

export function curatedPick(pid: string): CuratedPick | undefined {
  return byPid.get(pid);
}

export function picksFor(sector?: Sector): CuratedPick[] {
  return CURATED_PICKS.filter((p) => !sector || p.sector === sector).sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "stock" ? -1 : 1));
}

/** Highest number in a listing title followed by a unit, e.g. "9900mAh" → 9900. */
function maxWithUnit(name: string, unit: RegExp): number {
  let max = 0;
  for (const m of name.matchAll(new RegExp(`(\\d[\\d,.]*)\\s*(?:${unit.source})`, "gi"))) max = Math.max(max, Number(m[1].replace(/,/g, "")) || 0);
  return max;
}

/**
 * Listings whose own title makes a physically impossible claim: an 18650 cell over 3,600 mAh or a 21700 over 5,500 mAh
 * (the real maximums), a pack whose own layout can't hold its amp-hours (13S3P of 18650s at 29Ah needs 9,700 mAh
 * cells), or a flashlight or headlamp claiming 20,000+ lumens. Sellers who inflate the headline number
 * inflate everything else, and these are the parts that start fires.
 */
export function impossibleClaim(name: string): boolean {
  const mah = maxWithUnit(name, /mah\b/);
  if (/\b18650\b/.test(name) && mah > 3600) return true;
  if (/\b21700\b/.test(name) && mah > 5500) return true;
  const layout = name.match(/\b\d{1,2}S(\d{1,2})P\b/i);
  const cell = /\b18650\b/.test(name) ? 3.6 : /\b21700\b/.test(name) ? 5.5 : 0;
  if (layout && cell && maxWithUnit(name, /ah\b/) > Number(layout[1]) * cell) return true;
  if (/\b(head\s?lamp|headlight|flash\s?light|torch)\b/i.test(name) && maxWithUnit(name, /lm\b|lumens?\b/) >= 20_000) return true;
  return false;
}

/** Puts curated picks first, keeping each group's own order. */
export function picksFirst<T extends { pid: string }>(hits: T[]): T[] {
  return [...hits.filter((h) => byPid.has(h.pid)), ...hits.filter((h) => !byPid.has(h.pid))];
}
