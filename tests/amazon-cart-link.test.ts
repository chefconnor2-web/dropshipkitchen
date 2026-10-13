// The "Check out on Amazon" link: Amazon's add-to-cart URL built from what Neon added, and the per-chat cart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { amazonCartLink, cartLinesFor, newChatCart, noteAdded, noteCartRead, noteKept, rebuildChatCart } from "../lib/connectors/amazon";

test("builds Amazon's add-to-cart URL with numbered ASIN/Quantity pairs, merged and capped", () => {
  const r = amazonCartLink("amazon.ca", [
    { asin: "B0ABCDEFGH", quantity: 2 },
    { asin: "b0abcdefgh", quantity: 1 },
    { asin: "B012345678", quantity: 99 },
    { asin: "bad", quantity: 1 },
    { asin: "B0ZZZZZZZZ", quantity: 0 },
  ])!;
  assert.equal(r.url, "https://www.amazon.ca/gp/aws/cart/add.html?ASIN.1=B0ABCDEFGH&Quantity.1=3&ASIN.2=B012345678&Quantity.2=30");
  assert.equal(r.products, 2);
  assert.equal(r.units, 33);
  assert.deepEqual(r.skipped, ["BAD", "B0ZZZZZZZZ"]);
  assert.equal(amazonCartLink("evil.com", [{ asin: "B0ABCDEFGH", quantity: 1 }]), null);
  assert.equal(amazonCartLink("amazon.com", []), null);
});

test("at most 30 products", () => {
  const lines = Array.from({ length: 35 }, (_, i) => ({ asin: `B0${String(i).padStart(8, "0")}`, quantity: 1 }));
  assert.equal(amazonCartLink("amazon.com", lines)!.products, 30);
});

test("the chat cart adds up adds, trusts a cart read, and keeps items Amazon wouldn't add for the link", () => {
  const c = newChatCart();
  noteAdded(c, "amazon.ca", "s1", "B0ABCDEFGH", 1);
  noteAdded(c, "amazon.ca", "s1", "B0ABCDEFGH", 2);
  noteKept(c, "amazon.ca", "B012345678", 4);
  assert.deepEqual(cartLinesFor(c, "amazon.ca"), [
    { asin: "B0ABCDEFGH", quantity: 3 },
    { asin: "B012345678", quantity: 4 },
  ]);
  // The cart page says 2 of the first, and the kept item isn't in it (it never went in): it stays for the link.
  noteCartRead(c, "amazon.ca", "s1", [{ asin: "B0ABCDEFGH", quantity: 2 }]);
  assert.deepEqual(cartLinesFor(c, "amazon.ca"), [
    { asin: "B0ABCDEFGH", quantity: 2 },
    { asin: "B012345678", quantity: 4 },
  ]);
  assert.deepEqual(cartLinesFor(c, "amazon.com"), []);
});

test("rebuilt from saved history after a restart", () => {
  const messages = [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "amazon_add_to_cart", input: { asin: "B0ABCDEFGH", quantity: 2 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ asin: "B0ABCDEFGH", added: true, quantity: 2, site: "amazon.ca" }) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "amazon_add_to_cart", input: { asin: "B0FAILEDXX" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: JSON.stringify({ asin: "B0FAILEDXX", added: false, site: "amazon.ca" }) }] },
  ];
  assert.deepEqual(cartLinesFor(rebuildChatCart(messages, "amazon.ca"), "amazon.ca"), [{ asin: "B0ABCDEFGH", quantity: 2 }]);
});
