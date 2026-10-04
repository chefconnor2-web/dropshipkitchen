/**
 * Puts every storefront price on the store rule (30% over CJ cost, at least $10 profit), from the
 * cached CJ cost. No CJ calls. Runs on every container start, and switches SQLite to WAL first.
 *
 *   npm run reprice
 */
import "./seed-env";
import { prisma } from "@/lib/db";
import { applyPricingRule } from "@/lib/pricing";

// WAL lets the storefront keep reading while a background catalog import writes (persists on the db file).
prisma
  .$queryRawUnsafe("PRAGMA journal_mode=WAL;")
  .catch(() => null)
  .then(() => applyPricingRule())
  .then((n) => console.log(`[reprice] ${n} variant price${n === 1 ? "" : "s"} updated to the store rule`))
  .finally(() => prisma.$disconnect());
