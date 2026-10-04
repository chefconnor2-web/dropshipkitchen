// Preset mystery boxes: high-value boxes (guaranteed worth ~1.5x the price at our list prices) the AI builds
// on request. They lean on low-cost items, whose list price carries our $10 minimum margin, so the value
// promise is big while the store still clears its minimum profit on every draw.

import { prisma } from "@/lib/db";
import { buildBoxWithAI, type BoxBrief } from "@/lib/box-builder";
import { loadPool, simulate } from "@/lib/mystery";

export const BOX_PRESETS: Array<BoxBrief & { key: string }> = [
  { key: "workshop", brief: "Workshop Starter: handy hand tools, measuring tools and clever gadgets for DIY and repairs", priceCents: 3900, itemCount: 4, guaranteedValueCents: 6000, minProfitCents: 800 },
  { key: "desk", brief: "Desk Gadget Drop: useful, fun desk and office gadgets, organisers and phone/laptop accessories (no power banks)", priceCents: 3900, itemCount: 4, guaranteedValueCents: 6000, minProfitCents: 800 },
  { key: "kitchen", brief: "Kitchen Gadget Haul: clever kitchen tools and gadgets for home cooks (no knives, no glass)", priceCents: 4900, itemCount: 5, guaranteedValueCents: 7500, minProfitCents: 1000 },
  { key: "camp", brief: "Camp & Trail: practical camping, hiking and outdoor gear (no batteries, no knives, no stoves or fuel)", priceCents: 5900, itemCount: 5, guaranteedValueCents: 9000, minProfitCents: 1000 },
  { key: "garage", brief: "Garage & Car Care: car cleaning, organisation and handy garage tools and gadgets (no liquids or chemicals)", priceCents: 6900, itemCount: 6, guaranteedValueCents: 10500, minProfitCents: 1200 },
];

// One preset run at a time, in this server process (CJ is rate-limited, so builds go one after another).
export const presetJob: { running: boolean; done: string[]; current: string | null; log: string[] } = { running: false, done: [], current: null, log: [] };

/** Builds every preset that doesn't exist yet, one at a time; publishes those whose test draws all pass. */
export function startPresetBuild(): boolean {
  if (presetJob.running) return false;
  presetJob.running = true;
  presetJob.done = [];
  presetJob.log = [];
  void (async () => {
    try {
      for (const p of BOX_PRESETS) {
        const existing = await prisma.mysteryBox.findFirst({ where: { brief: p.brief } });
        // A box without a build log was cut off mid-build (e.g. by a redeploy): start it again.
        if (existing && !existing.buildLog) await prisma.mysteryBox.delete({ where: { id: existing.id } });
        else if (existing) {
          presetJob.done.push(p.key);
          continue;
        }
        presetJob.current = p.key;
        try {
          const id = await buildBoxWithAI(p, (e) => {
            if (e.type === "progress") presetJob.log = [...presetJob.log.slice(-15), `${p.key}: ${e.note}`];
          });
          const box = await prisma.mysteryBox.findUniqueOrThrow({ where: { id } });
          const stats = simulate(await loadPool(id), box);
          if (stats.successRate >= 0.95) await prisma.mysteryBox.update({ where: { id }, data: { status: "PUBLISHED" } });
          presetJob.log.push(`${p.key}: built, ${Math.round(stats.successRate * 100)}% healthy${stats.successRate >= 0.95 ? ", published" : ", left as draft"}`);
        } catch (e) {
          presetJob.log.push(`${p.key}: failed (${e instanceof Error ? e.message : e})`);
        }
        presetJob.done.push(p.key);
      }
    } finally {
      presetJob.running = false;
      presetJob.current = null;
    }
  })();
  return true;
}
