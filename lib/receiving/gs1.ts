// GS1-128 / GS1 DataBar parsing for case labels.
// Produce case stickers (GFS, Markon, PTI labels) encode GTIN, lot and dates as GS1 Application Identifiers,
// either as raw scanner output (FNC1 = ASCII 29 separators) or as the human-readable "(01)…(10)…" line.

export type Gs1Data = {
  gtin?: string;
  lot?: string;
  serial?: string;
  productionDate?: string; // (11) YYYY-MM-DD
  packDate?: string; // (13)
  bestBefore?: string; // (15)
  sellBy?: string; // (16)
  expiry?: string; // (17)
  count?: string; // (37)
  netWeight?: string; // (310n) kg / (320n) lb, e.g. "0.9 kg"
  ais: Record<string, string>;
};

const GS = "\u001d";
const FIXED: Record<string, number> = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2 };
const VARIABLE = new Set(["10", "21", "22", "30", "37", "90", "91", "92", "93", "94", "95", "96", "97", "98", "99"]);

/** GS1 date YYMMDD -> YYYY-MM-DD. DD "00" means the last day of that month. */
export function gs1Date(v: string): string | undefined {
  if (!/^\d{6}$/.test(v)) return undefined;
  const year = 2000 + Number(v.slice(0, 2));
  const month = Number(v.slice(2, 4));
  let day = Number(v.slice(4, 6));
  if (month < 1 || month > 12) return undefined;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day === 0) day = last;
  if (day > last) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function splitRaw(raw: string): Record<string, string> {
  const ais: Record<string, string> = {};
  let s = raw.replace(/^\][A-Za-z]\d/, ""); // symbology identifier, e.g. "]C1"
  while (s.length >= 2) {
    if (s[0] === GS) {
      s = s.slice(1);
      continue;
    }
    const two = s.slice(0, 2);
    if (FIXED[two]) {
      ais[two] = s.slice(2, 2 + FIXED[two]);
      s = s.slice(2 + FIXED[two]);
    } else if (/^3[1-6]\d\d/.test(s.slice(0, 4))) {
      ais[s.slice(0, 4)] = s.slice(4, 10); // measures: 4-digit AI + 6 digits
      s = s.slice(10);
    } else if (VARIABLE.has(two)) {
      const end = s.indexOf(GS, 2);
      ais[two] = end === -1 ? s.slice(2) : s.slice(2, end);
      s = end === -1 ? "" : s.slice(end + 1);
    } else {
      break; // unknown AI: stop rather than mis-split the rest
    }
  }
  return ais;
}

export function parseGs1(input: string): Gs1Data | null {
  const text = input.trim();
  let ais: Record<string, string> = {};
  if (text.includes("(")) {
    for (const m of text.matchAll(/\((\d{2,4})\)\s*([^(]*)/g)) ais[m[1]] = m[2].replace(/\s+/g, "");
  } else if (/^(\][A-Za-z]\d)?\d{2}/.test(text) && (text.includes(GS) || text.startsWith("]") || /^(01|02)\d{14}/.test(text))) {
    ais = splitRaw(text);
  }
  if (!Object.keys(ais).length) return null;
  const out: Gs1Data = { ais };
  if (ais["01"] || ais["02"]) out.gtin = ais["01"] || ais["02"];
  if (ais["10"]) out.lot = ais["10"];
  if (ais["21"]) out.serial = ais["21"];
  if (ais["37"]) out.count = ais["37"];
  out.productionDate = ais["11"] && gs1Date(ais["11"]);
  out.packDate = ais["13"] && gs1Date(ais["13"]);
  out.bestBefore = ais["15"] && gs1Date(ais["15"]);
  out.sellBy = ais["16"] && gs1Date(ais["16"]);
  out.expiry = ais["17"] && gs1Date(ais["17"]);
  for (const [ai, v] of Object.entries(ais)) {
    const unit = ai.startsWith("310") ? "kg" : ai.startsWith("320") ? "lb" : null;
    if (unit && /^\d{6}$/.test(v)) out.netWeight = `${Number(v) / 10 ** Number(ai[3])} ${unit}`;
  }
  for (const k of Object.keys(out) as (keyof Gs1Data)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/** Merges every GS1 barcode decoded from one label; the first value seen for a field wins. */
export function mergeGs1(values: string[]): Gs1Data | null {
  const found = values.map(parseGs1).filter((d): d is Gs1Data => d !== null);
  if (!found.length) return null;
  return found.reduceRight<Gs1Data>((acc, d) => ({ ...acc, ...d, ais: { ...acc.ais, ...d.ais } }), { ais: {} });
}
