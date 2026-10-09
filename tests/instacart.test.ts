// Instacart connector: reading Neon's list, who gets the connector, and the calls to Instacart.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseList, instacartConnector } from "../lib/connectors/instacart";
import { enabledConnectors } from "../lib/connectors";
import { createRecipe, createShoppingList, label } from "../lib/instacart";

const seen: Array<{ path: string; auth: string; body: Record<string, unknown> }> = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", auth: String(req.headers.authorization), body: JSON.parse(raw || "{}") });
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("fail")) return res.writeHead(400).end(JSON.stringify({ error: { message: "bad line items" } }));
    res.end(JSON.stringify({ products_link_url: `https://customers.dev.instacart.tools/store/shopping_lists/${seen.length}` }));
  });
});
const ready = new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
after(() => server.close());

test("parseList cleans up the model's list and refuses unusable ones", () => {
  const ok = parseList({ title: " Taco night ", kind: "recipe", items: [{ name: "ground beef", quantity: 2, unit: "LB" }, { name: "limes", quantity: 0, unit: "" }, { name: "" }], instructions: ["Brown the beef", ""], servings: 6 });
  assert.ok(typeof ok !== "string");
  assert.equal(ok.title, "Taco night");
  assert.equal(ok.recipe, true);
  assert.deepEqual(ok.items, [
    { name: "ground beef", quantity: 2, unit: "lb" },
    { name: "limes", quantity: 1, unit: "each" },
  ]);
  assert.deepEqual(ok.steps, ["Brown the beef"]);
  assert.equal(ok.servings, 6);
  assert.equal(typeof parseList({ title: "", items: [{ name: "x", quantity: 1, unit: "each" }] }), "string");
  assert.equal(typeof parseList({ title: "Empty", items: [] }), "string");
  assert.equal(label({ name: "eggs", quantity: 12, unit: "each" }), "12 eggs");
  assert.equal(label({ name: "flour", quantity: 2.5, unit: "cup" }), "2.5 cup flour");
});

test("only testers get Instacart until it's opened to everyone, and then only in the US and Canada", () => {
  const prev = { key: process.env.INSTACART_API_KEY, roll: process.env.INSTACART_ROLLOUT };
  process.env.INSTACART_API_KEY = "test-key";
  delete process.env.INSTACART_ROLLOUT;
  const has = (who: { tester: boolean; country: string }) => enabledConnectors(who).includes(instacartConnector);
  assert.equal(has({ tester: false, country: "US" }), false);
  assert.equal(has({ tester: true, country: "GB" }), true);
  process.env.INSTACART_ROLLOUT = "everyone";
  assert.equal(has({ tester: false, country: "CA" }), true);
  assert.equal(has({ tester: false, country: "GB" }), false);
  delete process.env.INSTACART_API_KEY;
  assert.equal(has({ tester: true, country: "US" }), false);
  process.env.INSTACART_API_KEY = prev.key ?? "";
  if (!prev.key) delete process.env.INSTACART_API_KEY;
  if (prev.roll) process.env.INSTACART_ROLLOUT = prev.roll;
  else delete process.env.INSTACART_ROLLOUT;
});

test("shopping lists and recipes go to Instacart with the key, and errors come back readable", async () => {
  await ready;
  process.env.INSTACART_API_KEY = "test-key";
  process.env.INSTACART_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = await createShoppingList("Taco night", [{ name: "tortillas", quantity: 2, unit: "package" }]);
  assert.match(url, /shopping_lists\/1$/);
  assert.equal(seen[0].path, "/idp/v1/products/products_link");
  assert.equal(seen[0].auth, "Bearer test-key");
  assert.deepEqual((seen[0].body.line_items as unknown[])[0], { name: "tortillas", quantity: 2, unit: "package", display_text: "2 package tortillas" });
  await createRecipe("Tacos", [{ name: "beef", quantity: 1, unit: "lb" }], ["Cook it"], 4);
  assert.equal(seen[1].path, "/idp/v1/products/recipe");
  assert.equal(seen[1].body.servings, 4);

  const shown: unknown[] = [];
  const ctx = { progress: () => {}, show: (_g: string, items: unknown[]) => shown.push(...items) };
  const r = await instacartConnector.run("instacart_list", { title: "Snacks", kind: "shopping_list", items: [{ name: "chips", quantity: 3, unit: "bag" }], instructions: [], servings: 0 }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal((shown[0] as { kind: string; url: string }).kind, "grocery");

  process.env.INSTACART_API_URL += "/fail";
  const bad = await instacartConnector.run("instacart_list", { title: "Snacks", kind: "shopping_list", items: [{ name: "chips", quantity: 3, unit: "bag" }], instructions: [], servings: 0 }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.content, /bad line items/);
  delete process.env.INSTACART_API_KEY;
  delete process.env.INSTACART_API_URL;
});
