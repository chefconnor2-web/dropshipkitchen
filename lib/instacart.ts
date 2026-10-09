// Instacart Developer Platform: turns a list of items (or a recipe) into an Instacart page. The shopper picks a
// nearby store there and checks out on Instacart; we never take payment, hold stock or handle the delivery.
// Chit earns an affiliate commission on completed orders through Impact once the production key is approved.
//
// INSTACART_API_KEY  the key from Instacart's developer dashboard (a development key works on the test server)
// INSTACART_API_URL  defaults to the development server; https://connect.instacart.com once production is approved
// INSTACART_ROLLOUT  "everyone" offers it to all US and Canadian shoppers; otherwise only browsers turned on
//                    at /admin/instacart can use it

import { config } from "@/lib/config";

const DEV_URL = "https://connect.dev.instacart.tools";

export function instacartConfigured(): boolean {
  return !!process.env.INSTACART_API_KEY?.trim();
}

export function instacartBaseUrl(): string {
  return (process.env.INSTACART_API_URL?.trim() || DEV_URL).replace(/\/+$/, "");
}

export function instacartTestMode(): boolean {
  return instacartBaseUrl() === DEV_URL;
}

export function instacartForEveryone(): boolean {
  return process.env.INSTACART_ROLLOUT?.trim().toLowerCase() === "everyone";
}

export class InstacartError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export interface ListItem {
  name: string;
  quantity: number;
  unit: string;
}

async function post(path: string, body: unknown): Promise<string> {
  const res = await fetch(`${instacartBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.INSTACART_API_KEY?.trim()}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { products_link_url?: string; error?: { message?: string }; errors?: Array<{ message?: string }>; message?: string };
  if (!res.ok || !data.products_link_url) {
    const why = data.error?.message ?? data.errors?.[0]?.message ?? data.message ?? `HTTP ${res.status}`;
    throw new InstacartError(`Instacart: ${why}`, res.status);
  }
  return data.products_link_url;
}

// Shoppers who come back from Instacart land in the chat.
const landing = () => ({ partner_linkback_url: `${config.siteUrl}/`, enable_pantry_items: true });

/** A shopping list page: every item matched to products at the store the shopper picks. */
export function createShoppingList(title: string, items: ListItem[]): Promise<string> {
  return post("/idp/v1/products/products_link", {
    title,
    link_type: "shopping_list",
    line_items: items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, display_text: label(i) })),
    landing_page_configuration: landing(),
  });
}

/** A recipe page: ingredients plus steps, with one tap to add every ingredient. */
export function createRecipe(title: string, items: ListItem[], steps: string[], servings: number | null): Promise<string> {
  return post("/idp/v1/products/recipe", {
    title,
    ...(servings ? { servings } : {}),
    ingredients: items.map((i) => ({ name: i.name, display_text: label(i), measurements: [{ quantity: i.quantity, unit: i.unit }] })),
    instructions: steps,
    landing_page_configuration: landing(),
  });
}

/** "2 lb ground beef", "6 eggs". */
export function label(i: ListItem): string {
  const q = Number.isInteger(i.quantity) ? String(i.quantity) : String(Math.round(i.quantity * 100) / 100);
  return i.unit && i.unit !== "each" ? `${q} ${i.unit} ${i.name}` : `${q} ${i.name}`;
}
