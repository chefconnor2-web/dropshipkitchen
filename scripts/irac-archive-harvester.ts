import Anthropic from "@anthropic-ai/sdk";
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { createHash } from "node:crypto";

const { Pool } = pg;
const UA = "PEI-Public-Record-Archive/1.0";
const IRAC = "https://irac.pe.ca";
const RENTAL = "https://peirentaloffice.ca";
const concurrency = Math.max(1, Math.min(20, Number(process.env.ARCHIVE_CONCURRENCY || 12)));

const required = ["ARCHIVE_DATABASE_URL","S3_ENDPOINT","S3_BUCKET","S3_REGION","S3_ACCESS_KEY_ID","S3_SECRET_ACCESS_KEY"];
for (const key of required) if (!process.env[key]) throw new Error("Missing environment variable: " + key);

const pool = new Pool({ connectionString: process.env.ARCHIVE_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 20 });
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
});
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS archive_queue (
    url TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    kind TEXT NOT NULL,
    department TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT,
    byte_length BIGINT,
    mime TEXT,
    classification JSONB,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS archive_objects (
    sha256 TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL UNIQUE,
    byte_length BIGINT NOT NULL,
    mime TEXT,
    stored_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function robots(host: string) {
  try {
    const r = await fetch("https://" + host + "/robots.txt", { headers: { "user-agent": UA } });
    return r.ok ? await r.text() : "";
  } catch { return ""; }
}

function allowed(url: string, robotsText: string) {
  const path = new URL(url).pathname;
  const rules = robotsText.split(/\r?\n/).map(line => /^Disallow:\s*(\S+)/i.exec(line)?.[1]).filter(Boolean) as string[];
  return !rules.some(rule => rule !== "/" && path.startsWith(rule));
}

async function seedHost(base: string) {
  const host = new URL(base).hostname;
  const typesResp = await fetch(base + "/wp-json/wp/v2/types", { headers: { "user-agent": UA } });
  if (!typesResp.ok) throw new Error("Cannot enumerate types for " + base + ": " + typesResp.status);
  const types: any = await typesResp.json();
  let seeded = 0;

  for (const [type, def] of Object.entries(types) as [string, any][]) {
    const rest = def?.rest_base;
    if (!rest || ["wp_block","wp_template","wp_template_part","wp_navigation","nav_menu_item","wp_global_styles"].includes(type)) continue;

    for (let page = 1; page <= 200; page++) {
      const r = await fetch(base + "/wp-json/wp/v2/" + rest + "?per_page=100&page=" + page + "&orderby=id&order=asc", { headers: { "user-agent": UA } });
      if (r.status === 400) break;
      if (!r.ok) break;

      const rows: any[] = await r.json();
      for (const row of rows) {
        const url = type === "attachment" ? row.source_url : row.link;
        if (!url) continue;
        await pool.query(
          `INSERT INTO archive_queue(url,host,kind,department)
           VALUES($1,$2,$3,$4)
           ON CONFLICT(url) DO UPDATE SET department=EXCLUDED.department`,
          [url, host, type, String(row?.title?.rendered || type)]
        );
        seeded++;
      }

      if (page >= Number(r.headers.get("x-wp-totalpages") || 1)) break;
    }
  }
  return seeded;
}

async function classify(item: any) {
  if (!anthropic) return null;
  try {
    const message = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `Return strict JSON only. Classify this PEI public regulatory record without inventing missing facts.
Keys: record_type, department, docket, date, summary.
URL: ${item.url}
Kind: ${item.kind}
Title/department: ${item.department || ""}`
      }]
    });
    const block = message.content.find(x => x.type === "text");
    if (!block || block.type !== "text") return null;
    try { return JSON.parse(block.text); } catch { return { raw: block.text }; }
  } catch { return null; }
}

async function capture(item: any, robotsCache: Map<string,string>) {
  await pool.query("UPDATE archive_queue SET attempts=attempts+1,last_checked_at=now() WHERE url=$1", [item.url]);
  let robotsText = robotsCache.get(item.host);
  if (robotsText === undefined) {
    robotsText = await robots(item.host);
    robotsCache.set(item.host, robotsText);
  }

  if (!allowed(item.url, robotsText)) {
    await pool.query("UPDATE archive_queue SET status='robots_excluded' WHERE url=$1", [item.url]);
    return "excluded";
  }

  try {
    const response = await fetch(item.url, { headers: { "user-agent": UA, accept: "*/*" }, redirect: "follow" });
    if (!response.ok) {
      await pool.query("UPDATE archive_queue SET status=$2 WHERE url=$1", [item.url, "http_" + response.status]);
      return "failed";
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = "sha256/" + sha256.slice(0, 2) + "/" + sha256;
    const mime = (response.headers.get("content-type") || "application/octet-stream").split(";")[0];

    try {
      await s3.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
    } catch {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET!,
        Key: key,
        Body: bytes,
        ContentType: "application/octet-stream",
        Metadata: { original_mime: mime },
      }));
    }

    await pool.query(
      `INSERT INTO archive_objects(sha256,storage_key,byte_length,mime)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(sha256) DO NOTHING`,
      [sha256, key, bytes.byteLength, mime]
    );

    const classification = await classify(item);
    await pool.query(
      `UPDATE archive_queue
       SET status='captured',sha256=$2,byte_length=$3,mime=$4,classification=$5::jsonb
       WHERE url=$1`,
      [item.url, sha256, bytes.byteLength, mime, classification ? JSON.stringify(classification) : null]
    );
    return "captured";
  } catch {
    await pool.query("UPDATE archive_queue SET status='retry' WHERE url=$1", [item.url]);
    return "failed";
  }
}

async function run() {
  await initDb();
  const [iracSeeded, rentalSeeded] = await Promise.all([seedHost(IRAC), seedHost(RENTAL)]);
  console.log(JSON.stringify({ stage: "seeded", iracSeeded, rentalSeeded }));

  const robotsCache = new Map<string,string>();
  let totalCaptured = 0;
  let totalFailed = 0;
  let totalExcluded = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT * FROM archive_queue
       WHERE status IN ('pending','retry') AND attempts < 5
       ORDER BY first_seen_at
       LIMIT 1000`
    );
    if (!rows.length) break;

    let index = 0;
    async function worker() {
      while (true) {
        const i = index++;
        if (i >= rows.length) return;
        const result = await capture(rows[i], robotsCache);
        if (result === "captured") totalCaptured++;
        else if (result === "excluded") totalExcluded++;
        else totalFailed++;
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(JSON.stringify({ stage: "batch", selected: rows.length, totalCaptured, totalFailed, totalExcluded }));
  }

  const stats = await pool.query(`SELECT status,count(*)::int AS count,coalesce(sum(byte_length),0)::bigint AS bytes FROM archive_queue GROUP BY status ORDER BY status`);
  console.log(JSON.stringify({ stage: "complete", stats: stats.rows }));
  await pool.end();
}

run().catch(async error => {
  console.error(error);
  try { await pool.end(); } catch {}
  process.exit(1);
});
