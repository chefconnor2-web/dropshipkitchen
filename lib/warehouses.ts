// Which warehouse can ship where. The store's rule:
//   - US warehouse stock ships to US addresses only.
//   - China warehouse stock ships to the US and Canada (and wherever else CJ has a route).
// Used by every shipping quote (cart, checkout, CJ order), the product badges and the assistant.

/** Can a parcel from this CJ warehouse country go to this destination? */
export function canShipFrom(origin: string, dest: string | null | undefined): boolean {
  if (origin === "US") return dest === "US";
  return true;
}

export interface WarehouseSet {
  us: boolean;
  cn: boolean;
  /** At least one stock row was seen (otherwise we don't know and assume China, CJ's default). */
  known: boolean;
}

/** Warehouses holding stock, from CJ stock rows ([{countryCode, totalInventoryNum}]) of one or more variants. */
export function warehousesFrom(inventoryJsons: Array<string | null | undefined>): WarehouseSet {
  const out: WarehouseSet = { us: false, cn: false, known: false };
  for (const json of inventoryJsons) {
    try {
      for (const r of JSON.parse(json || "[]") as Array<{ countryCode?: string; totalInventoryNum?: number; storageNum?: number }>) {
        if (!r.countryCode) continue;
        out.known = true;
        const n = r.totalInventoryNum ?? r.storageNum ?? 0;
        if (n > 0 && r.countryCode === "US") out.us = true;
        if (n > 0 && r.countryCode === "CN") out.cn = true;
      }
    } catch {
      /* no usable rows */
    }
  }
  return out;
}

/** "US" (US warehouse only), "CN" (China), "US,CN" (both), or null when unknown. Stored with ship checks. */
export function originsCode(w: WarehouseSet): string | null {
  if (!w.known) return null;
  return [w.us ? "US" : "", w.cn ? "CN" : ""].filter(Boolean).join(",") || null;
}

export function parseOrigins(code: string | null | undefined): WarehouseSet {
  const parts = (code ?? "").split(",");
  return { us: parts.includes("US"), cn: parts.includes("CN"), known: !!code };
}

/** True when the product only sits in the US warehouse, so it can't reach a non-US address. */
export function usOnly(w: WarehouseSet): boolean {
  return w.known && w.us && !w.cn;
}

/** A short line for shoppers and the assistant about where a product ships from and to. */
export function warehouseLabel(w: WarehouseSet): string | null {
  if (!w.known || (!w.us && !w.cn)) return null;
  if (w.us && w.cn) return "In the US and China warehouses · ships to the US and Canada";
  if (w.us) return "US warehouse · ships to US addresses only";
  return "China warehouse · ships to the US and Canada";
}
