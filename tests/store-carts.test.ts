import { test } from "node:test";
import assert from "node:assert/strict";
import { amazonCarts, amazonProduct, metaProduct, bigcommerceProductId, cartLinks, detectPlatform, isPrivateAddress, jsonLdProduct, pickOption, shopifyHandle, subtotal, wooProductId, type StoreLine } from "../lib/connectors/stores";

const line = (over: Partial<StoreLine>): StoreLine => ({ url: "https://s.test/p", title: "Thing", quantity: 1, priceCents: 1000, currency: "USD", available: true, id: "1", ...over });

test("private and loopback addresses are never fetched", () => {
  for (const ip of ["127.0.0.1", "10.2.3.4", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "nonsense"]) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["23.227.38.65", "104.16.1.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("platform detection", () => {
  assert.equal(detectPlatform('<link href="//cdn.shopify.com/s/files/x.css">'), "shopify");
  assert.equal(detectPlatform('<body class="woocommerce single-product">'), "woocommerce");
  assert.equal(detectPlatform('<script>var BCData = {};</script>'), "bigcommerce");
  assert.equal(detectPlatform("<html>plain</html>"), "other");
});

test("Shopify handle from product URLs", () => {
  assert.equal(shopifyHandle(new URL("https://s.test/products/eve-lf280k?variant=1")), "eve-lf280k");
  assert.equal(shopifyHandle(new URL("https://s.test/collections/cells/products/eve-mb31")), "eve-mb31");
  assert.equal(shopifyHandle(new URL("https://s.test/pages/about")), null);
});

test("option picking: every asked word, the only option, or ask", () => {
  const opts = [{ title: "Pack of 4" }, { title: "Pack of 16" }, { title: "Single cell" }];
  assert.equal(pickOption(opts, "pack of 16")?.title, "Pack of 16");
  assert.equal(pickOption(opts, "single")?.title, "Single cell");
  assert.equal(pickOption(opts, undefined), null);
  assert.equal(pickOption(opts, "pack of 8"), null);
  assert.equal(pickOption([{ title: "Default" }], "anything")?.title, "Default");
  const volts = [{ title: "48 Volts" }, { title: "72 Volts" }];
  assert.equal(pickOption(volts, "48V")?.title, "48 Volts");
  assert.equal(pickOption([{ title: "800 Amps (5-8 KW)" }, { title: "1000 Amps (6-10 KW)" }], "1000A")?.title, "1000 Amps (6-10 KW)");
});

test("schema.org product data, including @graph and offer arrays", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Product","name":"Gigavac GX14","sku":"GX14","offers":[{"@type":"Offer","price":"189.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}]}]}</script>`;
  assert.deepEqual(jsonLdProduct(html), { name: "Gigavac GX14", priceCents: 18900, currency: "USD", available: true, sku: "GX14" });
  assert.equal(jsonLdProduct(`<script type="application/ld+json">{"@type":"Product","name":"X","offers":{"price":5,"priceCurrency":"CAD","availability":"OutOfStock"}}</script>`)?.available, false);
  assert.equal(jsonLdProduct("<script type=\"application/ld+json\">not json</script>"), null);
});

test("WooCommerce and BigCommerce product ids", () => {
  assert.equal(wooProductId('<button type="submit" name="add-to-cart" value="4521" class="single_add_to_cart_button">'), "4521");
  assert.equal(wooProductId('<form class="variations_form cart"><button name="add-to-cart" value="9">'), null);
  assert.equal(bigcommerceProductId('<input type="hidden" name="product_id" value="812"/>'), "812");
});

test("cart links per platform", () => {
  const lines = [line({ id: "111", quantity: 12 }), line({ id: "222", quantity: 1 }), line({ id: null })];
  assert.deepEqual(cartLinks("https://s.test", "shopify", lines), [{ label: "Open cart", url: "https://s.test/cart/111:12,222:1" }]);
  assert.equal(cartLinks("https://s.test", "woocommerce", lines)[0].url, "https://s.test/?add-to-cart=111&quantity=12");
  assert.equal(cartLinks("https://s.test", "bigcommerce", lines)[1].url, "https://s.test/cart.php?action=add&product_id=222&qty=1");
  assert.deepEqual(cartLinks("https://s.test", "other", lines), []);
  assert.equal(cartLinks("https://s.test", "shopify", [line({ id: "1", quantity: 5000 })])[0].url, "https://s.test/cart/1:999");
});

test("subtotal only when every line is priced in one currency", () => {
  assert.deepEqual(subtotal([line({ priceCents: 39900, quantity: 12 }), line({ priceCents: 1000 })]), { cents: 479800, currency: "USD" });
  assert.equal(subtotal([line({}), line({ priceCents: null })]).cents, null);
  assert.equal(subtotal([line({}), line({ currency: "CAD" })]).cents, null);
});

test("name and price from page tags when there's no schema.org data", () => {
  const html = `<head><title>Fuse | EV West</title><meta property="og:title" content="High Voltage Fuse 500 Volt 400 Amp &amp; holder"><meta property="product:price:amount" content="69.00"><meta property="product:price:currency" content="USD"></head>`;
  assert.deepEqual(metaProduct(html), { name: "High Voltage Fuse 500 Volt 400 Amp & holder", priceCents: 6900, currency: "USD" });
  assert.deepEqual(metaProduct('<title>Inertia Switch</title><span itemprop="price" content="15.00"></span>'), { name: "Inertia Switch", priceCents: 1500, currency: undefined });
  assert.equal(metaProduct("<p>nothing</p>").priceCents, undefined);
  assert.equal(metaProduct('<h1>DC/DC Converter</h1><div class="product-price"><span>$549.00</span></div>').priceCents, 54900);
});

test("Amazon product links become one Amazon cart link per site, with no page read", () => {
  assert.deepEqual(amazonProduct("https://www.amazon.ca/dp/b0fvwzbc6q?th=1"), { domain: "amazon.ca", asin: "B0FVWZBC6Q" });
  assert.deepEqual(amazonProduct("https://amazon.com/Some-Title/dp/B07DQ5H3T2/ref=x"), { domain: "amazon.com", asin: "B07DQ5H3T2" });
  assert.equal(amazonProduct("https://www.amazon.ca/s?k=bms"), null);
  assert.equal(amazonProduct("https://evil-amazon.ca.example.com/dp/B07DQ5H3T2"), null);
  const carts = amazonCarts([
    { url: "https://www.amazon.ca/dp/B0FVWZBC6Q", quantity: 1, title: "JK BMS" },
    { url: "https://www.amazon.ca/dp/B0FVLNMHMQ", quantity: 2, title: "Heater pad" },
    { url: "https://shop.example.com/products/x" },
  ]);
  assert.equal(carts.length, 1);
  assert.equal(carts[0].store, "amazon.ca");
  assert.equal(carts[0].links[0].url, "https://www.amazon.ca/gp/aws/cart/add.html?ASIN.1=B0FVWZBC6Q&Quantity.1=1&ASIN.2=B0FVLNMHMQ&Quantity.2=2");
  assert.equal(carts[0].lines[1].title, "Heater pad");
});
