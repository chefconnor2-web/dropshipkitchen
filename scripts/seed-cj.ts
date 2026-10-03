/**
 * Demo seed: finds ~10 REAL chef-supply products through CJ's official Product List V2 API and
 * imports them (product/query + variant data + stock/queryByVid per VID). Nothing is invented.
 *
 *   npm run seed:cj                 # import as DRAFT
 *   npm run seed:cj -- --publish    # import and publish to /shop
 *   npm run seed:cj -- --limit 6
 *   npm run seed:cj -- --publish --replace   # also unpublish products that aren't in this catalog
 *
 * Retries rate-limited (429) CJ calls up to CJ_RATE_LIMIT_RETRIES times (default here: 8).
 * Requires CJ_API_KEY. Makes read-only catalog calls; never creates a CJ order.
 */
import "./seed-env";
import { prisma } from "@/lib/db";
import { cjConfigured } from "@/lib/config";
import { listProductsV2 } from "@/lib/cj/client";
import { parseListV2 } from "@/lib/cj/normalize";
import { importCjProduct } from "@/lib/cj/import";

// Search term + what a relevant title must / must not contain (keeps unrelated products out),
// plus the clean storefront name we sell it under. CJ's keyword search is loose, so `must` matches
// the actual use, not just the noun. BRANDED skips third-party brand listings.
const BRANDED = /kegani|qulajoy|vevor|pasabahce|pasa baahce|flashfish|smith's|ezarc|ericsity|amazon|walmart|temu|prohibited/i;
/** Variant names that are only a foreign plug standard. */
const FOREIGN_PLUG = /\b(EU|UK|AU|GB)\b(?!.*\bUS\b)/i;
// `title` may hold {W}: the wattage from the CJ listing name. `minWatts` skips listings below it.
const TARGETS: Array<{ q: string; must: RegExp; not?: RegExp; variantNot?: RegExp; minWatts?: number; category: string; title: string }> = [
  { q: "300W portable power station", must: /power station/i, not: /accessor|panel only|stall|night market/i, category: "Power", title: "{W}W Portable Power Station" },
  { q: "solar power bank", must: /solar.*power bank|power bank.*solar/i, not: /keychain|shell|mini|lipstick/i, category: "Power", title: "Solar Power Bank" },
  { q: "solar panel portable", must: /solar panel/i, minWatts: 30, not: /bag$|bag portable|power station|generator|kit|photovoltaic/i, category: "Solar", title: "{W}W Portable Solar Panel" },
  { q: "camping lantern rechargeable", must: /lantern/i, not: /string|seven-color|vintage|retro/i, variantNot: /\bAA\b|\d+AA|aaa/i, category: "Light", title: "Rechargeable Camp Lantern" },
  { q: "headlamp rechargeable", must: /headlamp/i, not: /laser|fishing|fluorescence/i, category: "Light", title: "Rechargeable Headlamp" },
  { q: "water filter straw", must: /filter|purif/i, not: /case|box|bottle/i, category: "Water", title: "Filter Straw" },
  { q: "gravity water filter bag", must: /(gravity|bag)/i, not: /case|box|bottle|garbage|dust/i, category: "Water", title: "Gravity Water Filter" },
  { q: "hand crank radio", must: /crank/i, not: /speaker|lighter/i, category: "Comms", title: "Solar Hand-Crank Radio" },
  { q: "fire starter", must: /flint|fire starter|spark/i, not: /wax|barbecue|car|motor|jump|tinder maker|bow drill/i, category: "Fire & Cook", title: "Ferro Rod Fire Starter" },
  { q: "camping stove", must: /stove/i, not: /bracket|table|burner|kerosene|head|cassette|electric/i, category: "Fire & Cook", title: "Compact Camp Stove" },
  { q: "emergency survival kit", must: /survival|emergency kit/i, not: /self.?defen|whip|medical|first.?aid|blanket/i, category: "Survival", title: "Emergency Survival Kit" },
];

function watts(name: string): number | null {
  const m = name.match(/(\d{2,4})\s?W\b/i);
  return m ? Number(m[1]) : null;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!cjConfigured()) {
    console.error("CJ_API_KEY is not set. Add it to .env and retry.");
    process.exit(1);
  }
  const publish = process.argv.includes("--publish");
  const replace = process.argv.includes("--replace");
  const keep = new Set<string>();
  const limit = Number(arg("limit") ?? 10);
  const done = new Set((await prisma.cjSupplierProduct.findMany({ select: { cjProductId: true } })).map((p) => p.cjProductId));
  let imported = 0;

  for (const t of TARGETS) {
    if (imported >= limit) break;
    // Re-runs are idempotent: a target already in the catalog is kept, not imported again.
    const existing = await prisma.product.findFirst({
      where: { categories: t.category, title: { endsWith: t.title.replace("{W}W ", "") } },
    });
    if (existing) {
      keep.add(existing.id);
      if (publish && existing.status !== "PUBLISHED")
        await prisma.product.update({ where: { id: existing.id }, data: { status: "PUBLISHED" } });
      console.log(`\n[catalog] "${existing.title}" already imported as ${existing.internalSku}`);
      continue;
    }
    process.stdout.write(`\n[listV2] "${t.q}" … `);
    let items;
    try {
      items = parseListV2((await listProductsV2(t.q, 1, 20)).data).items;
    } catch (e) {
      console.log(`search failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const candidates = items
      .filter((r) => !done.has(r.pid) && t.must.test(r.name) && !(t.not && t.not.test(r.name)) && !BRANDED.test(r.name))
      .filter((r) => !t.minWatts || (watts(r.name) ?? 0) >= t.minWatts)
      .slice(0, 3);
    console.log(`${items.length} results, ${candidates.length} relevant`);
    for (const pick of candidates) {
      try {
        const r = await importCjProduct(pick.pid, { deliveryCycle: pick.deliveryCycle });
        done.add(pick.pid);
        // Variants that don't fit the product we sell (e.g. AA-battery versions of a "rechargeable" lantern) stay off.
        const variants = await prisma.productVariant.findMany({ where: { productId: r.productId } });
        if (t.variantNot) {
          const off = variants.filter((v) => t.variantNot!.test(v.name)).map((v) => v.id);
          if (off.length) await prisma.productVariant.updateMany({ where: { id: { in: off } }, data: { enabled: false } });
        }
        const sellable = variants.filter((v) => v.enabled && !(t.variantNot && t.variantNot.test(v.name)));
        // Supplier copy that names another brand or marketplace would show on our product page.
        const sp = await prisma.product.findUnique({ where: { id: r.productId }, include: { supplierProduct: true } });
        if (BRANDED.test(sp?.supplierProduct?.cjDescription ?? "")) {
          console.log(`   skipped ${pick.name}: its description names another brand or marketplace`);
          await prisma.product.delete({ where: { id: r.productId } });
          continue;
        }
        // A US store can't sell a listing whose only versions are foreign plugs.
        if (sellable.length === 0 || sellable.every((v) => FOREIGN_PLUG.test(v.name))) {
          console.log(`   skipped ${pick.name}: no US-usable variant (${variants.map((v) => v.name).join(", ")})`);
          await prisma.product.delete({ where: { id: r.productId } });
          continue;
        }
        imported++;
        keep.add(r.productId);
        const w = watts(pick.name);
        const title = t.title.replace("{W}W ", w ? `${w}W ` : "");
        let slug = slugify(title);
        for (let n = 2; await prisma.product.findFirst({ where: { slug, id: { not: r.productId } } }); n++) slug = `${slugify(title)}-${n}`;
        const product = await prisma.product.update({
          where: { id: r.productId },
          data: { title, slug, categories: t.category, ...(publish ? { status: "PUBLISHED" } : {}) },
        });
        console.log(`   → ${pick.name} [PID ${pick.pid}]`);
        console.log(`   imported ${r.variantCount} variants (stock checked ${r.stockChecked}) as ${product.internalSku} "${product.title}"`);
        if (r.stockErrors.length) console.log(`   stock errors: ${r.stockErrors.join("; ")}`);
        break;
      } catch (e) {
        console.log(`   import failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  // Only swap catalogs when the new one actually imported, so a CJ outage never empties the shop.
  if (replace && keep.size > 0) {
    const hidden = await prisma.product.updateMany({
      where: { status: "PUBLISHED", id: { notIn: [...keep] } },
      data: { status: "DRAFT" },
    });
    console.log(`Unpublished ${hidden.count} product(s) from the previous catalog (kept as DRAFT).`);
  }
  console.log(`\nDone. Imported ${imported} real CJ product(s)${publish ? " and published them" : " as DRAFT"}.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
