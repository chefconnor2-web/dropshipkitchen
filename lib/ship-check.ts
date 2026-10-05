// "Ships to Canada" badges on product cards: does one unit of a product ship to the shopper's country?
// Answers come from the same live CJ freight quote as the cart (all warehouses tried) and are kept for a
// week per product and country, so a grid shows them at once after the first look. Unknown ones are worked
// out in the background, behind anything a shopper is waiting on, and the card fills in when ready.
import { prisma } from "@/lib/db";
import { getVariantsByPid } from "@/lib/cj/client";
import { withCjPriority } from "@/lib/cj/lanes";
import { quoteCart } from "@/lib/shipping";
import { processSingleton } from "@/lib/singleton";
import { PID_RE } from "@/lib/open-product";

export type ShipStatus = { state: "ok"; cents: number | null } | { state: "no" } | { state: "pending" };

const TTL_MS = 7 * 86_400_000;
/** Products checked per request (the rest are asked for again as the shopper scrolls or polls). */
const MAX_PER_REQUEST = 30;
const inflight = processSingleton("ship-check-inflight", () => new Map<string, Promise<void>>());

/** Cached answers for these products in this country; anything unknown or stale starts a background check. */
export async function shipStatuses(pids: string[], country: string): Promise<Record<string, ShipStatus>> {
  const wanted = [...new Set(pids.filter((p) => PID_RE.test(p)))].slice(0, MAX_PER_REQUEST);
  const rows = await prisma.shipCheck.findMany({ where: { country, pid: { in: wanted } } });
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out: Record<string, ShipStatus> = {};
  for (const pid of wanted) {
    const r = byPid.get(pid);
    if (r) out[pid] = r.ok ? { state: "ok", cents: r.cents } : { state: "no" };
    else out[pid] = { state: "pending" };
    if (!r || Date.now() - r.checkedAt.getTime() > TTL_MS) startCheck(pid, country);
  }
  return out;
}

function startCheck(pid: string, country: string) {
  const key = `${pid}|${country}`;
  if (inflight.has(key)) return;
  const job = withCjPriority("background", () => check(pid, country))
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, job.then(() => undefined));
}

/** One unit of the product's first option, quoted to the country like a one-item cart. */
async function check(pid: string, country: string) {
  const item = await firstItem(pid);
  if (!item) return; // couldn't tell (CJ error): leave it unknown, try again next time
  const quote = await quoteCart([{ ...item, quantity: 1 }], country);
  const standard = quote.tiers.find((t) => t.key === "standard") ?? quote.tiers[0];
  const data = { ok: quote.tiers.length > 0, cents: standard?.cents ?? null, checkedAt: new Date() };
  await prisma.shipCheck.upsert({ where: { pid_country: { pid, country } }, create: { pid, country, ...data }, update: data });
}

/** The product's first sellable option: from our catalog when imported, else straight from CJ (one call). */
async function firstItem(pid: string): Promise<{ vid: string; inventoryJson: string | null; weightGrams: number | null } | null> {
  const sv = await prisma.cjSupplierVariant.findFirst({
    where: { supplierProduct: { cjProductId: pid }, offers: { some: {} } },
    orderBy: { id: "asc" },
    select: { cjVariantId: true, inventoryJson: true, weightGrams: true },
  });
  if (sv) return { vid: sv.cjVariantId, inventoryJson: sv.inventoryJson, weightGrams: sv.weightGrams };
  const variants = (await getVariantsByPid(pid)).data ?? [];
  const v = variants[0];
  if (!v?.vid) return null;
  const grams = Number(v.variantWeight);
  return { vid: v.vid, inventoryJson: null, weightGrams: Number.isFinite(grams) && grams > 0 ? grams : null };
}
