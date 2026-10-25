import Anthropic from "@anthropic-ai/sdk";
import { S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createServer } from "node:http";
import pg from "pg";
import { createHash } from "node:crypto";
import archiver from "archiver";

const { Pool } = pg;
const UA = "PEI-Public-Record-Archive/1.0";
const IRAC = "https://irac.pe.ca";
const RENTAL = "https://peirentaloffice.ca";
const concurrency = Math.max(1, Math.min(20, Number(process.env.ARCHIVE_CONCURRENCY || 12)));
const CLAUDE_MODEL = "claude-haiku-5-5";

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

async function fetchWithRetry(url: string, init: RequestInit = {}, attempts = 4) {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (error) {
      last = error;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

async function seedHost(base: string) {
  const host = new URL(base).hostname;
  const typesResp = await fetchWithRetry(base + "/wp-json/wp/v2/types", { headers: { "user-agent": UA } });
  if (!typesResp.ok) throw new Error("Cannot enumerate types for " + base + ": " + typesResp.status);
  const types: any = await typesResp.json();
  let seeded = 0;

  for (const [type, def] of Object.entries(types) as [string, any][]) {
    const rest = def?.rest_base;
    if (!rest || ["wp_block","wp_template","wp_template_part","wp_navigation","nav_menu_item","wp_global_styles"].includes(type)) continue;

    for (let page = 1; page <= 200; page++) {
      const r = await fetchWithRetry(base + "/wp-json/wp/v2/" + rest + "?per_page=100&page=" + page + "&orderby=id&order=asc", { headers: { "user-agent": UA } });
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
      model: CLAUDE_MODEL,
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


function json(res: any, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": status === 200 ? "public, max-age=30" : "no-store",
  });
  res.end(JSON.stringify(body));
}

function safeLimit(value: string | null, fallback = 50) {
  const n = Number(value || fallback);
  return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : fallback;
}

function safeOffset(value: string | null) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function normalizeMime(mime: string | null | undefined) {
  const m = (mime || "application/octet-stream").toLowerCase().split(";")[0].trim();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) ? m : "application/octet-stream";
}

async function archiveStats() {
  const [queue, objects] = await Promise.all([
    pool.query(`SELECT status,count(*)::int AS count,coalesce(sum(byte_length),0)::bigint AS bytes
                FROM archive_queue GROUP BY status ORDER BY status`),
    pool.query(`SELECT count(*)::int AS objects,coalesce(sum(byte_length),0)::bigint AS bytes
                FROM archive_objects`)
  ]);
  return { queue: queue.rows, objects: objects.rows[0] || { objects: 0, bytes: 0 } };
}

async function listRecords(url: URL) {
  const q = (url.searchParams.get("q") || "").trim();
  const status = (url.searchParams.get("status") || "captured").trim();
  const host = (url.searchParams.get("host") || "").trim();
  const kind = (url.searchParams.get("kind") || "").trim();
  const limit = safeLimit(url.searchParams.get("limit"));
  const offset = safeOffset(url.searchParams.get("offset"));

  const where: string[] = [];
  const values: any[] = [];
  const add = (sql: string, value: any) => {
    values.push(value);
    where.push(sql.replace("?", "$" + values.length));
  };

  if (status) add("q.status = ?", status);
  if (host) add("q.host = ?", host);
  if (kind) add("q.kind = ?", kind);
  if (q) {
    values.push("%" + q + "%");
    const p = "$" + values.length;
    where.push(`(
      q.url ILIKE ${p}
      OR coalesce(q.department,'') ILIKE ${p}
      OR coalesce(q.classification->>'record_type','') ILIKE ${p}
      OR coalesce(q.classification->>'department','') ILIKE ${p}
      OR coalesce(q.classification->>'docket','') ILIKE ${p}
      OR coalesce(q.classification->>'summary','') ILIKE ${p}
    )`);
  }

  values.push(limit, offset);
  const limitP = "$" + (values.length - 1);
  const offsetP = "$" + values.length;
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const rows = await pool.query(
    `SELECT q.url,q.host,q.kind,q.department,q.status,q.sha256,q.byte_length,q.mime,
            q.classification,q.first_seen_at,q.last_checked_at,
            o.storage_key,o.stored_at
       FROM archive_queue q
       LEFT JOIN archive_objects o ON o.sha256=q.sha256
       ${whereSql}
       ORDER BY coalesce(q.last_checked_at,q.first_seen_at) DESC
       LIMIT ${limitP} OFFSET ${offsetP}`,
    values
  );

  return { records: rows.rows, limit, offset };
}

async function getRecord(sha256: string) {
  const r = await pool.query(
    `SELECT q.url,q.host,q.kind,q.department,q.status,q.sha256,q.byte_length,q.mime,
            q.classification,q.first_seen_at,q.last_checked_at,
            o.storage_key,o.stored_at
       FROM archive_queue q
       LEFT JOIN archive_objects o ON o.sha256=q.sha256
       WHERE q.sha256=$1
       ORDER BY q.last_checked_at DESC NULLS LAST
       LIMIT 1`,
    [sha256]
  );
  return r.rows[0] || null;
}

function extForMime(mime: string | null | undefined) {
  const m = normalizeMime(mime);
  const map: Record<string,string> = {
    "application/pdf": ".pdf",
    "text/html": ".html",
    "text/plain": ".txt",
    "application/json": ".json",
    "application/xml": ".xml",
    "text/xml": ".xml",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "video/mp4": ".mp4"
  };
  return map[m] || "";
}

function safeArchiveName(value: string) {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "record";
}

async function streamFullArchive(res: any) {
  const rows = await pool.query(
    `SELECT q.url,q.host,q.kind,q.department,q.status,q.sha256,q.byte_length,q.mime,
            q.classification,q.first_seen_at,q.last_checked_at,
            o.storage_key,o.stored_at
       FROM archive_queue q
       JOIN archive_objects o ON o.sha256=q.sha256
      WHERE q.status='captured' AND q.sha256 IS NOT NULL
      ORDER BY coalesce(q.last_checked_at,q.first_seen_at),q.url`
  );

  const records = rows.rows;
  const archive = archiver("zip", {
    zlib: { level: 0 },
    forceZip64: true
  });

  archive.on("warning", (error) => console.warn("bulk archive warning", error));
  archive.on("error", (error) => {
    console.error("bulk archive error", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "archive_stream_failed" }));
    } else {
      res.destroy(error);
    }
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="forage-atlas-full-corpus-${stamp}.zip"`,
    "cache-control": "no-store",
    "x-archive-record-count": String(records.length),
    "access-control-allow-origin": "*"
  });

  archive.pipe(res);

  const manifest: any[] = [];
  let index = 0;
  for (const record of records) {
    index++;
    const ext = extForMime(record.mime);
    const base = safeArchiveName(record.url);
    const internalName = `records/${String(index).padStart(5,"0")}-${base}-${record.sha256.slice(0,12)}${ext}`;
    manifest.push({
      index,
      path: internalName,
      url: record.url,
      host: record.host,
      kind: record.kind,
      department: record.department,
      mime: normalizeMime(record.mime),
      byteLength: Number(record.byte_length || 0),
      sha256: record.sha256,
      firstSeenAt: record.first_seen_at,
      capturedAt: record.last_checked_at,
      storedAt: record.stored_at
    });

    const object = await s3.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: record.storage_key
    }));
    if (!object.Body) throw new Error("Missing S3 body for " + record.sha256);
    archive.append(object.Body as any, { name: internalName });
  }

  archive.append(JSON.stringify({
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    archive: "Forage Atlas preserved corpus",
    records: manifest
  }, null, 2), { name: "manifest.json" });

  await archive.finalize();
}

async function getInlineUrl(record: any) {
  if (!record?.storage_key) return null;
  const mime = normalizeMime(record.mime);
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: record.storage_key,
    ResponseContentType: mime,
    ResponseContentDisposition: `inline; filename="archive-${record.sha256.slice(0,12)}"`,
  });
  return getSignedUrl(s3, command, { expiresIn: 300 });
}

function startApi() {
  const port = Number(process.env.PORT || 3000);
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return json(res, 204, {});
      if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });

      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname === "/health") {
        return json(res, 200, { ok: true, service: "irac-harvester", claudeModel: CLAUDE_MODEL, concurrency });
      }
      if (url.pathname === "/api/archive/stats") {
        return json(res, 200, await archiveStats());
      }
      if (url.pathname === "/api/archive/records") {
        return json(res, 200, await listRecords(url));
      }
      if (url.pathname === "/api/archive/download-all.zip") {
        await streamFullArchive(res);
        return;
      }

      const m = /^\/api\/archive\/records\/([a-f0-9]{64})(?:\/(view))?$/.exec(url.pathname);
      if (m) {
        const record = await getRecord(m[1]);
        if (!record) return json(res, 404, { error: "record_not_found" });
        if (m[2] === "view") {
          const signedUrl = await getInlineUrl(record);
          if (!signedUrl) return json(res, 404, { error: "object_not_found" });
          return json(res, 200, { sha256: record.sha256, mime: normalizeMime(record.mime), expiresIn: 300, url: signedUrl });
        }
        return json(res, 200, { record });
      }

      return json(res, 404, { error: "not_found" });
    } catch (error) {
      console.error("api error", error);
      return json(res, 500, { error: "internal_error" });
    }
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ stage: "api", port }));
  });
}

async function run() {
  await initDb();
  console.log(JSON.stringify({ stage: "config", claudeModel: CLAUDE_MODEL, concurrency }));
  const existing = await pool.query("SELECT count(*)::int AS count FROM archive_queue");
  const existingCount = Number(existing.rows[0]?.count || 0);
  if (existingCount < 10000) {
    let iracSeeded = 0;
    let rentalSeeded = 0;
    try { iracSeeded = await seedHost(IRAC); } catch (error) { console.error("IRAC seed error", error); }
    try { rentalSeeded = await seedHost(RENTAL); } catch (error) { console.error("Rental Office seed error", error); }
    console.log(JSON.stringify({ stage: "seeded", iracSeeded, rentalSeeded }));
  } else {
    console.log(JSON.stringify({ stage: "resume", existingCount }));
  }

  const robotsCache = new Map<string,string>();
  let totalCaptured = 0;
  let totalFailed = 0;
  let totalExcluded = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT * FROM archive_queue
       WHERE status IN ('pending','retry') AND attempts < 5
       ORDER BY first_seen_at
       LIMIT 2000`
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
}

startApi();
run().catch(error => {
  console.error("harvest error", error);
});
