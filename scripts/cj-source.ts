/**
 * Submits CJ sourcing requests for products CJ doesn't list yet, then reports their status.
 *
 *   npm run cj:source                    # submit scripts/sourcing-requests.json
 *   npm run cj:source -- --file sourcing-requests-platforms.json   # submit another list in scripts/
 *   npm run cj:source -- --status ID...  # check earlier requests by CJ sourcing id
 *
 * Once CJ approves a request it gets a normal CJ product (PID) that imports like any other.
 */
import "./seed-env";
import { readFileSync } from "node:fs";
import { createSourcing, querySourcing, type CjSourcingRequest } from "@/lib/cj/client";
import { prisma } from "@/lib/db";

async function main() {
  const i = process.argv.indexOf("--status");
  if (i >= 0) {
    try {
      const env = await querySourcing(process.argv.slice(i + 1));
      console.log(JSON.stringify(env.data, null, 2));
    } catch (e) {
      // CJ answers "not data" until its agents have picked a request up.
      console.log(`No status from CJ yet: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }
  const f = process.argv.indexOf("--file");
  const file = (f >= 0 ? process.argv[f + 1] : "sourcing-requests.json").replace(/^.*[\\/]/, "");
  const requests = JSON.parse(readFileSync(new URL(`./${file}`, import.meta.url), "utf8")) as CjSourcingRequest[];
  for (const r of requests) {
    try {
      const env = await createSourcing(r);
      console.log(`submitted  ${env.data?.cjSourcingId ?? "(no id)"}  ${r.productName}  requestId=${env.requestId}`);
    } catch (e) {
      console.log(`failed     ${r.productName}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().finally(() => prisma.$disconnect());
