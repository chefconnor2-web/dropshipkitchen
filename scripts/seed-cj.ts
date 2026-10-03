/**
 * Demo seed: finds ~10 REAL chef-supply products through CJ's official Product List V2 API and
 * imports them (product/query + variant data + stock/queryByVid per VID). Nothing is invented.
 *
 *   npm run seed:cj                 # import as DRAFT
 *   npm run seed:cj -- --publish    # import and publish to /shop
 *   npm run seed:cj -- --limit 6
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

// Search term + what a relevant title must / must not contain (keeps unrelated products out).
// CJ's keyword search is loose (e.g. "plating tweezers" returns ear spoons and phone cases), so
// `must` matches the kitchen use, not just the noun. BRANDED excludes third-party brand names.
const BRANDED = /kegani|qulajoy|vevor|pasabahce|pasa baahce/i;
const TARGETS: Array<{ q: string; must: RegExp; not?: RegExp; category: string }> = [
  { q: "chef knife", must: /chef'?s? knife|gyuto|santoku/i, not: /bag|storage|set|scimitar|slaughter/i, category: "Knives" },
  { q: "knife sharpener", must: /kitchen knife sharpener|sharpening stone|knife sharpener/i, not: /woodwork|belt|machine|cutting board|chopping board/i, category: "Knives" },
  { q: "kitchen tongs", must: /tongs/i, not: /hair|curl|plate|bowl/i, category: "Tools" },
  { q: "kitchen scissors", must: /kitchen shears|poultry|bone scissors/i, not: /hair|garden|tailor|embroider/i, category: "Tools" },
  { q: "fish spatula", must: /fish spatula|slotted.*turner/i, not: /makeup|cosmetic|tank|aquarium/i, category: "Spatulas" },
  { q: "silicone spatula", must: /spatula/i, not: /makeup|cosmetic|eye|mask|wax|paint|putty|phone|holder/i, category: "Spatulas" },
  { q: "cake decorating", must: /decorating mouth|piping|icing tip|nozzle set/i, not: /christmas|tree|candle|card/i, category: "Pastry" },
  { q: "silicone baking", must: /silicone.*(scraper|brush|baking mat|cupcake)/i, not: /makeup|hair|nail|tooth/i, category: "Pastry" },
  { q: "kitchen thermometer", must: /(food|kitchen|oil|meat|bbq|barbecue|cooking).*thermometer/i, not: /aquarium|reptile|fish|forehead|body|baby|violin|motorcycle/i, category: "Thermometers" },
  { q: "kitchen scale", must: /kitchen scale|baking scale|food (weighing )?scale/i, not: /body|human|baggage|suitcase|luggage|refrigerant|bench/i, category: "Measuring" },
  { q: "oil spray bottle", must: /oil (sprayer|spray|mister|dispenser)|sprayer bottle/i, not: /hair|essential|mop|aroma|skin|body|scalp/i, category: "Bottles" },
  { q: "measuring cup", must: /measuring (cup|spoon)/i, not: /wax|nose|body|tape|laser/i, category: "Measuring" },
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
    const pick = items.find((r) => !done.has(r.pid) && t.must.test(r.name) && !(t.not && t.not.test(r.name)) && !BRANDED.test(r.name));
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
