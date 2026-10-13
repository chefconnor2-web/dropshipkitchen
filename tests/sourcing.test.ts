// Open sourcing: supplier cards only link to pages the web searches returned, and searches are costed.
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { parseSuppliers, seenPages } from "../lib/sourcing";
import { costMicros } from "../lib/ai-cost";

const results = [
  {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: [
      { type: "web_search_result", url: "https://www.made-in-china.com/showroom/press-co/product-detailXYZ/500T-Deep-Drawing-Press.html", title: "500T press", encrypted_content: "x" },
      { type: "web_search_result", url: "https://presscompany.en.alibaba.com/", title: "Press Co", encrypted_content: "x" },
    ],
  },
  { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_fetch_result", url: "https://slugs.example.cn/1070-aluminum-slugs/", content: { type: "document", source: { type: "text", media_type: "text/plain", data: "" } } } },
] as unknown as Anthropic.Beta.BetaContentBlock[];

test("supplier cards keep only links the searches returned", () => {
  const seen = seenPages(results, new Set());
  const { group, cards, dropped } = parseSuppliers(
    {
      group: "Extrusion press",
      suppliers: [
        { name: "Press Co", url: "https://made-in-china.com/showroom/press-co/product-detailXYZ/500T-Deep-Drawing-Press.html", offer: "500T four-column press", location: "Tengzhou, Shandong", price: "$21,000 / set", moq: "1 set" },
        // Same site as a result, different page: allowed.
        { name: "Press Co store", url: "https://presscompany.en.alibaba.com/product/123.html", offer: "Deep drawing press" },
        { name: "Slug Mill", url: "https://slugs.example.cn/1070-aluminum-slugs", offer: "1070 slugs, 66 mm" },
        // Never returned by a search: dropped.
        { name: "Made Up Ltd", url: "https://made-up-supplier.com/press", offer: "Imaginary press" },
        { name: "No link", url: "", offer: "Press" },
      ],
    },
    seen,
  );
  assert.equal(group, "Extrusion press");
  assert.deepEqual(cards.map((c) => c.name), ["Press Co", "Press Co store", "Slug Mill"]);
  assert.deepEqual(dropped, ["Made Up Ltd", "No link"]);
  assert.equal(cards[0].kind, "supplier");
  assert.equal(cards[0].price, "$21,000 / set");
  assert.equal(cards[0].location, "Tengzhou, Shandong");
  assert.equal(cards[1].price, undefined);
  assert.notEqual(cards[0].id, cards[1].id);
});

test("no search results means no supplier cards", () => {
  const { cards } = parseSuppliers({ group: "x", suppliers: [{ name: "A", url: "https://a.com", offer: "b" }] }, new Set());
  assert.equal(cards.length, 0);
});

test("web searches are charged at $10 per 1,000", () => {
  const base = { input_tokens: 1000, output_tokens: 100 };
  const plain = costMicros("claude-sonnet-5-5", base);
  assert.equal(costMicros("claude-sonnet-5-5", { ...base, server_tool_use: { web_search_requests: 3 } }) - plain, 30_000);
});
