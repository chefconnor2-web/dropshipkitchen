// CSV of Link line waitlist sign-ups. Under /admin, so the admin login protects it.
import { prisma } from "@/lib/db";
import { linkProductById, platformById, platformName } from "@/lib/lineup";

export const dynamic = "force-dynamic";

function cell(v: unknown) {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET() {
  const rows = await prisma.waitlistEntry.findMany({ orderBy: { createdAt: "asc" } });
  const head = ["email", "battery", "product", "signed_up", "notified"];
  const lines = rows.map((r) =>
    [r.email, platformName(platformById(r.platform)), linkProductById(r.productId)?.name ?? r.productId, r.createdAt.toISOString(), r.notifiedAt?.toISOString()]
      .map(cell)
      .join(","),
  );
  return new Response([head.join(","), ...lines].join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="waitlist-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}
