// Photo upload for the assistant. The browser resizes images first (long edge ≤ 1568px, the most Claude
// uses), so the body is small. Raw image bytes in, {id} out.
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { ensureVisitorId } from "@/lib/chat-session";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const hits = new Map<string, number[]>();
function allow(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= 60) return false;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value!);
  return true;
}

/** Detects the format from the file's first bytes; only types Claude can read. */
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export async function POST(req: Request) {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (!allow(ip)) return Response.json({ error: "Too many photos. Try again later." }, { status: 429 });
  if (Number(h.get("content-length") ?? 0) > MAX_BYTES) return Response.json({ error: "That photo is too large." }, { status: 413 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) return Response.json({ error: "That photo is too large." }, { status: 413 });
  const mime = sniff(bytes);
  if (!mime) return Response.json({ error: "Use a JPEG, PNG, WebP or GIF photo." }, { status: 415 });
  const visitorId = await ensureVisitorId();
  const img = await prisma.assistantImage.create({ data: { visitorId, mime, data: Buffer.from(bytes) }, select: { id: true } });
  return Response.json({ id: img.id });
}
