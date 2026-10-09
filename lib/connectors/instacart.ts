// Groceries through Instacart: Neon turns a meal, a recipe or a shopping list into one Instacart link. The shopper
// picks a store and checks out on Instacart. No prices here (each store prices its own shelves) and no AI scouts,
// so a grocery turn costs less than a product search.

import { randomBytes } from "node:crypto";
import { createRecipe, createShoppingList, instacartConfigured, instacartForEveryone, instacartTestMode, InstacartError, type ListItem } from "@/lib/instacart";
import { config } from "@/lib/config";
import type { GroceryList } from "@/lib/flights-shared";
import type { Connector } from "./types";

const MAX_ITEMS = 60;
const MAX_STEPS = 30;
/** Where Instacart operates. */
const COUNTRIES = new Set(["US", "CA"]);

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Validates the model's list; returns why it's unusable instead of throwing. */
export function parseList(input: Record<string, unknown>): { title: string; recipe: boolean; items: ListItem[]; steps: string[]; servings: number | null } | string {
  const title = str(input.title, 80);
  if (!title) return "give the list a short title";
  const items = (Array.isArray(input.items) ? input.items : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const quantity = Number(o.quantity);
      return { name: str(o.name, 80), quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(quantity, 999) : 1, unit: str(o.unit, 20).toLowerCase() || "each" };
    })
    .filter((i) => i.name);
  if (!items.length) return "the list needs at least one item";
  if (items.length > MAX_ITEMS) return `keep it to ${MAX_ITEMS} items or fewer`;
  const recipe = input.kind === "recipe";
  const steps = (Array.isArray(input.instructions) ? input.instructions : []).map((s) => str(s, 400)).filter(Boolean).slice(0, MAX_STEPS);
  const servings = Math.round(Number(input.servings));
  return { title, recipe, items, steps, servings: servings > 0 && servings <= 100 ? servings : null };
}

export const instacartConnector: Connector = {
  id: "instacart",
  label: "Groceries (Instacart)",
  enabled: instacartConfigured,
  // Until launch, only browsers turned on at /admin/instacart; then shoppers in the US and Canada.
  available: ({ tester, country }) => tester || (instacartForEveryone() && COUNTRIES.has(country)),
  prompt: () => `
Groceries (Instacart):
- For groceries, meal ingredients, recipes, snacks, drinks and household staples from a supermarket, build an Instacart list with instacart_list instead of searching the factory catalog. The shopper opens it on Instacart, picks a nearby store, and checks out and gets delivery there.${instacartTestMode() ? " (Instacart is in TEST mode: links go to Instacart's test site.)" : ""}
- One call per list. Use kind "recipe" (with short steps and servings) when they want to cook something specific; otherwise "shopping_list". Sensible quantities and units for the people and days they mention (e.g. 2 lb ground beef, 1 dozen eggs); plain product names, no brands unless asked.
- Never quote grocery prices or delivery times: each store sets its own on Instacart. Don't add groceries to the ${config.storeName} cart; they're bought on Instacart.
- After the list is made, say it's ready in a line or two (the shopper sees a card with the items and a "Shop on Instacart" button). A chat can have both: e.g. party supplies from the catalog plus the food on Instacart.`,
  tools: [
    {
      name: "instacart_list",
      description: "Make an Instacart shopping list or recipe page from items. Returns a link; the shopper sees a card with the items and a Shop on Instacart button.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title the shopper sees, e.g. 'Taco night for 6'" },
          kind: { type: "string", enum: ["shopping_list", "recipe"] },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Plain product name, e.g. 'ground beef', 'corn tortillas'" },
                quantity: { type: "number" },
                unit: { type: "string", description: "each, lb, oz, g, kg, cup, tbsp, tsp, dozen, package, can, bottle…" },
              },
              required: ["name", "quantity", "unit"],
              additionalProperties: false,
            },
          },
          instructions: { type: "array", items: { type: "string" }, description: "Recipe steps, or empty for a shopping list" },
          servings: { type: "integer", description: "Servings for a recipe, or 0" },
        },
        required: ["title", "kind", "items", "instructions", "servings"],
        additionalProperties: false,
      },
    },
  ],
  async run(tool, input, ctx) {
    if (tool !== "instacart_list") return { content: `Unknown tool ${tool}.`, isError: true };
    const list = parseList(input);
    if (typeof list === "string") return { content: `Can't make that list: ${list}.`, isError: true };
    ctx.progress(`Building your Instacart ${list.recipe ? "recipe" : "list"} (${list.items.length} item${list.items.length === 1 ? "" : "s"})…`);
    try {
      const url = list.recipe ? await createRecipe(list.title, list.items, list.steps, list.servings) : await createShoppingList(list.title, list.items);
      const card: GroceryList = { kind: "grocery", id: `ic_${randomBytes(6).toString("hex")}`, title: list.title, url, recipe: list.recipe, items: list.items, group: "Instacart" };
      ctx.show("Instacart", [card]);
      return { content: JSON.stringify({ ok: true, title: list.title, items: list.items.length, shown_as_card: true }) };
    } catch (e) {
      return { content: `Couldn't make the Instacart list: ${e instanceof InstacartError || e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  },
};
