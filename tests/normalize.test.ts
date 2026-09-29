// Unit tests for the pure CJ payload normalizers. These use hand-written payload fragments
// shaped like CJ's documented responses — test inputs only, never loaded into the store.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveOptions,
  parseListV2,
  productImages,
  sumInventory,
  toCustomerText,
  normalizeVariant,
} from "../lib/cj/normalize";
import { priceToCents, suggestRetailCents } from "../lib/money";

test("parseListV2 reads data.content[].productList[]", () => {
  const { items, total } = parseListV2({
    totalRecords: 42,
    content: [{ productList: [{ id: "PID1", nameEn: "Plating Tweezers", sku: "CJSKU1", bigImage: "https://x/i.jpg", nowPrice: "3.20", warehouseInventoryNum: 150, deliveryCycle: "3-5" }] }],
  });
  assert.equal(total, 42);
  assert.equal(items[0].pid, "PID1");
  assert.equal(items[0].priceCents, 320);
  assert.equal(items[0].inventory, 150);
  assert.equal(items[0].deliveryCycle, "3-5");
});

test("parseListV2 tolerates empty / alternate shapes", () => {
  assert.deepEqual(parseListV2(null).items, []);
  assert.equal(parseListV2({ list: [{ id: "A" }] }).items[0].pid, "A");
});

test("priceToCents handles numbers, strings and ranges", () => {
  assert.equal(priceToCents(12.84), 1284);
  assert.equal(priceToCents("17.2"), 1720);
  assert.equal(priceToCents("1.20 -- 3.40"), 120);
  assert.equal(priceToCents(null), null);
});

test("deriveOptions splits CJ keys when they line up", () => {
  const r = deriveOptions("Color-Size", [
    { variantKey: "Black-30cm", variantName: null, cjVariantSku: "a" },
    { variantKey: "Silver-20cm", variantName: null, cjVariantSku: "b" },
  ]);
  assert.deepEqual(r.optionNames, ["Color", "Size"]);
  assert.deepEqual(r.values[0], { Color: "Black", Size: "30cm" });
});

test("deriveOptions falls back to the whole CJ key instead of inventing options", () => {
  const r = deriveOptions("Color-Size", [
    { variantKey: "Black-Long-30cm", variantName: null, cjVariantSku: "a" },
    { variantKey: "Silver-20cm", variantName: null, cjVariantSku: "b" },
  ]);
  assert.deepEqual(r.optionNames, ["Option"]);
  assert.deepEqual(r.values[0], { Option: "Black-Long-30cm" });
});

test("productImages parses JSON-array strings and productImageSet", () => {
  assert.deepEqual(
    productImages({ pid: "p", productSku: "s", productImage: '["https://a/1.jpg","https://a/2.jpg"]', productImageSet: ["https://a/1.jpg"] }),
    ["https://a/1.jpg", "https://a/2.jpg"],
  );
});

test("sumInventory totals warehouses", () => {
  assert.equal(sumInventory([{ totalInventoryNum: 400 }, { totalInventoryNum: 83 }]), 483);
  assert.equal(sumInventory([{ storageNum: 5 }]), 5);
  assert.equal(sumInventory([]), 0);
  assert.equal(sumInventory(null), null);
});

test("normalizeVariant keeps exact identifiers", () => {
  const n = normalizeVariant({ vid: "VID-9", pid: "P", variantSku: "CJSKU-Black-30", variantSellPrice: 4.1, variantWeight: 55 });
  assert.equal(n.cjVariantId, "VID-9");
  assert.equal(n.cjVariantSku, "CJSKU-Black-30");
  assert.equal(n.supplierPriceCents, 410);
  assert.equal(n.weightGrams, 55);
});

test("toCustomerText strips HTML and supplier references", () => {
  const t = toCustomerText("<p>Stainless steel.</p><p>Ships from CJ warehouse</p><img src='https://cf.cjdropshipping.com/x.jpg'><p>30cm long</p>");
  assert.equal(t, "Stainless steel.\n30cm long");
});

test("suggestRetailCents ends in .99", () => {
  assert.equal(suggestRetailCents(1284, 3), 3899);
});
