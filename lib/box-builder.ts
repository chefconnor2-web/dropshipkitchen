// AI box designer. The merchant writes a brief ("$49 workshop box, 4 tools for DIY guys"); Claude Sonnet 5.5
// plans the box, sends Haiku scouts to find candidates in CJ's live catalog (in the price band the rules
// need), and names and describes it. The server then imports the pool, keeps only options that fit, and
// simulates draws to prove the box can always meet its guarantees. Boxes are saved as drafts to review.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import { slugify } from "@/lib/cj/normalize";
import { openCjProduct } from "@/lib/open-product";
import { EFFORT, MODEL, runScouts, type AssistantEvent, type Part, type ScoutResult } from "@/lib/assistant";
import { loadPool, simulate, type BoxRules } from "@/lib/mystery";

export interface BoxBrief {
  brief: string;
  priceCents: number;
  itemCount: number;
  guaranteedValueCents?: number;
  minProfitCents?: number;
}

export type BuilderEvent = AssistantEvent | { type: "done"; boxId: string; summary: string } | { type: "error"; error: string };

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "find_products",
    description: "Send scouts to search the live catalog for several product categories at once. Returns up to 3 shortlisted products per category with pid, title and list price in USD.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        parts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Category label, e.g. 'Precision screwdrivers'" },
              need: { type: "string", description: "What a good pick looks like, including the price band" },
              queries: { type: "array", items: { type: "string" }, description: "1-3 short keyword queries" },
            },
            required: ["name", "need", "queries"],
            additionalProperties: false,
          },
        },
      },
      required: ["parts"],
      additionalProperties: false,
    },
  },
  {
    name: "save_box",
    description: "Save the box: its name, a one-line tagline, a short description for the product page, and the pids of the pool products (from find_products).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        tagline: { type: "string" },
        description: { type: "string" },
        pids: { type: "array", items: { type: "string" } },
      },
      required: ["name", "tagline", "description", "pids"],
      additionalProperties: false,
    },
  },
];

export function defaultRules(b: BoxBrief): BoxRules {
  return {
    priceCents: b.priceCents,
    itemCount: b.itemCount,
    guaranteedValueCents: b.guaranteedValueCents ?? Math.round(b.priceCents * 1.2),
    minProfitCents: b.minProfitCents ?? Math.max(800, Math.round(b.priceCents * 0.2)),
  };
}

/** List-price band each item should sit in so a draw can reach the guaranteed value. */
export function priceBand(r: BoxRules) {
  const avg = r.guaranteedValueCents / r.itemCount;
  return { lo: Math.max(999, Math.round(avg * 0.7)), hi: Math.round(avg * 1.9) };
}

export async function buildBoxWithAI(b: BoxBrief, emit: (e: BuilderEvent) => void): Promise<string> {
  const rules = defaultRules(b);
  const band = priceBand(rules);
  const client = new Anthropic();
  const usage = { in: 0, out: 0 };
  const known = new Map<string, { title: string; fromCents: number }>();
  let saved = null as { name: string; tagline: string; description: string; pids: string[] } | null;

  const system = `You design mystery boxes for ${config.storeName}, a Canadian store selling products from Chinese factories. A box is sold at a fixed price and each buyer gets ${rules.itemCount} different products drawn at random from a pool you choose.

Rules for the pool:
- 15 to 25 products that clearly fit the brief and feel like a fun, useful surprise. Vary the types; don't pick near-duplicates.
- Every product's list price must be between ${formatMoney(band.lo)} and ${formatMoney(band.hi)} (the scouts return list prices). That keeps every box worth at least ${formatMoney(rules.guaranteedValueCents)}.
- Nothing risky to ship or sell blind: no lithium batteries or power banks, liquids, aerosols, food, cosmetics or skincare, knives or weapons, adult items, medicine, fragile glass, branded or knock-off goods, clothing that needs a size.
- Use find_products once with 8 to 12 categories (2-3 short keyword queries each, and the price band in each need), retry any empty category once, then call save_box with the best products.
- The name is short and catchy, the tagline one line, the description 2-3 sentences: what kind of items are inside, that there are ${rules.itemCount} of them and that each box is worth at least ${formatMoney(rules.guaranteedValueCents)}. Never promise specific items.`;

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Brief: ${b.brief}\nPrice: ${formatMoney(rules.priceCents)} for ${rules.itemCount} items. Guaranteed value: ${formatMoney(rules.guaranteedValueCents)}.`,
    },
  ];

  emit({ type: "progress", note: "Planning the box…" });
  for (let round = 0; round < 6 && !saved; round++) {
    const r = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system,
      tools: TOOLS,
      messages,
      ...(MODEL.startsWith("claude-haiku") ? {} : { output_config: { effort: EFFORT }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    });
    usage.in += r.usage.input_tokens;
    usage.out += r.usage.output_tokens;
    messages.push({ role: "assistant", content: r.content });
    if (r.stop_reason !== "tool_use") break;
    const calls = r.content.filter((x): x is Anthropic.Beta.BetaToolUseBlock => x.type === "tool_use");
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const c of calls) {
      const input = c.input as Record<string, unknown>;
      if (c.name === "find_products") {
        const parts: Part[] = (Array.isArray(input.parts) ? input.parts : []).slice(0, 12).map((p) => {
          const o = p as Record<string, unknown>;
          const queries = (Array.isArray(o.queries) ? o.queries : []).map(String).filter(Boolean).slice(0, 3);
          return { name: String(o.name ?? "Item").slice(0, 40), need: String(o.need ?? "").slice(0, 300), queries: queries.length ? queries : [String(o.name ?? "")] };
        });
        emit({ type: "progress", note: `Sending ${parts.length} scouts to search…` });
        const found: ScoutResult[] = await runScouts(client, parts, emit, usage);
        for (const f of found) for (const p of f.picks) known.set(p.pid, { title: p.title, fromCents: Math.round(Number(p.from_price_usd) * 100) });
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(found) });
      } else if (c.name === "save_box") {
        const pids = (Array.isArray(input.pids) ? input.pids : []).map(String).filter((p) => known.has(p));
        if (pids.length < rules.itemCount + 2) {
          results.push({ type: "tool_result", tool_use_id: c.id, content: `Only ${pids.length} of those pids came from find_products. Find more products first.`, is_error: true });
        } else {
          saved = { name: String(input.name ?? "Mystery Box").slice(0, 60), tagline: String(input.tagline ?? "").slice(0, 140), description: String(input.description ?? "").slice(0, 1000), pids };
          results.push({ type: "tool_result", tool_use_id: c.id, content: "Saved." });
        }
      }
    }
    if (!saved) messages.push({ role: "user", content: results });
  }
  if (!saved) throw new Error("The AI didn't finish designing the box. Try again with a clearer brief.");

  // Import the pool and keep the options whose list price fits the band.
  let slug = slugify(saved.name) || "mystery-box";
  for (let n = 2; await prisma.mysteryBox.findUnique({ where: { slug } }); n++) slug = `${slugify(saved.name)}-${n}`;
  const box = await prisma.mysteryBox.create({
    data: { slug, name: saved.name, tagline: saved.tagline, description: saved.description, brief: b.brief, ...rules, status: "DRAFT" },
  });
  let kept = 0;
  for (const [i, pid] of saved.pids.entries()) {
    emit({ type: "progress", note: `Checking stock and prices ${i + 1}/${saved.pids.length}: ${known.get(pid)?.title ?? pid}` });
    const product = await openCjProduct(pid).catch(() => null);
    if (!product) continue;
    const variants = await prisma.productVariant.findMany({
      where: { productId: product.id, enabled: true, priceCents: { gte: band.lo, lte: band.hi }, offer: { isNot: null } },
      orderBy: { priceCents: "asc" },
      take: 3,
    });
    for (const v of variants) await prisma.mysteryBoxPoolItem.create({ data: { boxId: box.id, variantId: v.id } }).catch(() => null);
    if (variants.length) kept++;
  }

  const stats = simulate(await loadPool(box.id), rules);
  const summary = `${kept} products in the pool (${stats.inStockProducts} in stock). ${Math.round(stats.successRate * 100)}% of test draws met every rule; average box worth ${formatMoney(stats.avgValueCents)}, average profit ${formatMoney(stats.avgProfitCents)}. AI cost about ${formatMoney(Math.round(usage.in * 0.0002 + usage.out * 0.001))}.`;
  await prisma.mysteryBox.update({ where: { id: box.id }, data: { buildLog: summary } });
  emit({ type: "done", boxId: box.id, summary });
  return box.id;
}
