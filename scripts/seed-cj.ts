/**
 * Demo seed: finds ~10 REAL chef-supply products through CJ's official Product List V2 API and
 * imports them (product/query + variant data + stock/queryByVid per VID). Nothing is invented.
 *
 *   npm run seed:cj                 # import as DRAFT
 *   npm run seed:cj -- --publish    # import and publish to /shop
 *   npm run seed:cj -- --limit 6
 *
 * Requires CJ_API_KEY. Makes read-only catalog calls; never creates a CJ order.
 */
import { prisma } from "@/lib/db";
import { cjConfigured } from "@/lib/config";
import { listProductsV2 } from "@/lib/cj/client";
import { parseListV2 } from "@/lib/cj/normalize";
import { importCjProduct } from "@/lib/cj/import";

// Search term + what a relevant title must / must not contain (keeps unrelated products out).
const TARGETS: Array<{ q: string; must: RegExp; not?: RegExp; category: string }> = [
  { q: "plating tweezers", must: /tweezer/i, not: /eyebrow|eyelash|lash|nail|hair|beauty|makeup|electronic|esd|jewel/i, category: "Plating" },
  { q: "kitchen tweezers", must: /tweezer|tong/i, not: /eyebrow|eyelash|lash|nail|hair|beauty|makeup|esd/i, category: "Plating" },
  { q: "silicone spatula", must: /spatula/i, not: /makeup|cosmetic|mask|wax|paint|putty|phone/i, category: "Spatulas" },
  { q: "offset spatula", must: /spatula/i, not: /makeup|cosmetic|paint|putty/i, category: "Pastry" },
  { q: "food thermometer", must: /thermometer/i, not: /body|baby|fever|forehead|ear|aquarium|pool|room|hygrometer/i, category: "Thermometers" },
  { q: "piping bag nozzle", must: /piping|nozzle|pastry|icing|decorating/i, not: /hose|garden|3d print|printer/i, category: "Pastry" },
  { q: "squeeze bottle sauce", must: /squeeze|sauce|condiment|dispenser/i, not: /hair|dye|paint|cosmetic|shampoo/i, category: "Squeeze Bottles" },
  { q: "bench scraper", must: /scraper|dough|cutter/i, not: /car|ice|window|paint|glass|phone|screen|film|tile/i, category: "Pastry" },
  { q: "measuring spoons", must: /measur/i, not: /tape|ruler|laser|body|tailor/i, category: "Measuring" },
  { q: "kitchen scale digital", must: /scale/i, not: /body|bathroom|weight loss|luggage|fish|hanging|jewel/i, category: "Measuring" },
  { q: "kitchen organizer spice", must: /spice|organi[sz]er|rack/i, not: /cosmetic|makeup|jewel|shoe|closet|car/i, category: "Organization" },
  { q: "pastry brush silicone", must: /brush/i, not: /makeup|hair|tooth|paint|cosmetic|shoe|car/i, category: "Pastry" },
];

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
  const limit = Number(arg("limit") ?? 10);
  const done = new Set((await prisma.cjSupplierProduct.findMany({ select: { cjProductId: true } })).map((p) => p.cjProductId));
  let imported = 0;

  for (const t of TARGETS) {
    if (imported >= limit) break;
    process.stdout.write(`\n[listV2] "${t.q}" … `);
    let items;
    try {
      items = parseListV2((await listProductsV2(t.q, 1, 20)).data).items;
    } catch (e) {
      console.log(`search failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const pick = items.find((r) => !done.has(r.pid) && t.must.test(r.name) && !(t.not && t.not.test(r.name)));
    console.log(`${items.length} results${pick ? ` → ${pick.name} [PID ${pick.pid}]` : " → no relevant match"}`);
    if (!pick) continue;
    try {
      const r = await importCjProduct(pick.pid, { deliveryCycle: pick.deliveryCycle });
      done.add(pick.pid);
      imported++;
      const product = await prisma.product.update({
        where: { id: r.productId },
        data: {
          categories: t.category,
          ...(publish ? { status: "PUBLISHED" } : {}),
        },
      });
      console.log(`   imported ${r.variantCount} variants (stock checked ${r.stockChecked}) as ${product.internalSku} "${product.title}"`);
      if (r.stockErrors.length) console.log(`   stock errors: ${r.stockErrors.join("; ")}`);
    } catch (e) {
      console.log(`   import failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\nDone. Imported ${imported} real CJ product(s)${publish ? " and published them" : " as DRAFT"}.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
