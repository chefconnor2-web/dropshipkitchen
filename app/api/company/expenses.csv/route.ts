// GET ?month=YYYY-MM: work expenses as CSV (admins and approvers: the whole company; travelers: their own).
import { getMemberId } from "@/lib/session";
import { expenseRows, toCsv } from "@/lib/company";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = await getMemberId();
  if (!id) return new Response("Sign in first.", { status: 401 });
  const month = new URL(req.url).searchParams.get("month") ?? "";
  const m = /^\d{4}-\d{2}$/.test(month) ? month : undefined;
  const { rows, company } = await expenseRows(id, m);
  const name = `${(company ?? "my").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-expenses${m ? `-${m}` : ""}.csv`;
  return new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
}
