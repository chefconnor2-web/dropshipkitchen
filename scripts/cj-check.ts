/**
 * Quick live connectivity check against CJ's official API:
 *   npm run cj:check -- "tweezers"
 * Prints the token status, a few listV2 results, the first product's variants and one VID's stock.
 */
import { prisma } from "@/lib/db";
import { getProductDetail, getStockByVid, listProductsV2 } from "@/lib/cj/client";
import { normalizeVariant, parseListV2, sumInventory } from "@/lib/cj/normalize";

async function main() {
  const q = process.argv[2] || "kitchen";
  const list = await listProductsV2(q, 1, 5);
  console.log(`listV2 "${q}" requestId=${list.requestId}`);
  const { items, total } = parseListV2(list.data);
  console.log(`total=${total}`);
  for (const r of items) console.log(` - ${r.pid} | ${r.sku} | $${r.priceLabel} | inv ${r.inventory} | ${r.name}`);
  if (!items[0]) {
    console.log("Raw data:", JSON.stringify(list.data, null, 2).slice(0, 3000));
    return;
  }
  const d = await getProductDetail(items[0].pid);
  console.log(`\nproduct/query ${d.data.pid} requestId=${d.requestId} productKeyEn=${d.data.productKeyEn}`);
  for (const v of (d.data.variants ?? []).slice(0, 10).map(normalizeVariant))
    console.log(` - VID ${v.cjVariantId} | ${v.cjVariantSku} | key ${v.variantKey} | $${(v.supplierPriceCents ?? 0) / 100}`);
  const vid = d.data.variants?.[0]?.vid;
  if (vid) {
    const s = await getStockByVid(vid);
    console.log(`\nstock/queryByVid ${vid} requestId=${s.requestId} total=${sumInventory(s.data)}`);
    console.log(JSON.stringify(s.data, null, 2));
  }
}

main()
  .catch((e) => {
    console.error("CJ check failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
