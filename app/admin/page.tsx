import Link from "next/link";
import { prisma } from "@/lib/db";
import { CjStatusPanel, fmtTime } from "@/components/admin";

export default async function AdminHome() {
  const [products, published, awaiting, calls] = await Promise.all([
    prisma.product.count(),
    prisma.product.count({ where: { status: "PUBLISHED" } }),
    prisma.order.count({ where: { status: "AWAITING_MERCHANT_APPROVAL" } }),
    prisma.cjApiCall.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  return (
    <>
      <h1>Dashboard</h1>
      <CjStatusPanel back="/admin" />
      <div className="stats">
        <Link href="/admin/products" className="card pad">
          <div className="big">{products}</div>imported products
        </Link>
        <Link href="/admin/products" className="card pad">
          <div className="big">{published}</div>published
        </Link>
        <Link href="/admin/orders" className="card pad">
          <div className="big">{awaiting}</div>orders awaiting approval
        </Link>
      </div>
      <h2>Recent CJ API calls</h2>
      <p className="muted small">Every request this app makes to CJ&apos;s official API is logged here.</p>
      <table className="table small">
        <thead>
          <tr>
            <th>Time</th>
            <th>Call</th>
            <th>HTTP</th>
            <th>CJ code</th>
            <th>CJ requestId</th>
            <th>ms</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id}>
              <td>{fmtTime(c.createdAt)}</td>
              <td>
                <code>
                  {c.method} {c.path}
                  {c.query ? `?${c.query}` : ""}
                </code>
              </td>
              <td>{c.httpStatus ?? "—"}</td>
              <td>{c.cjCode ?? "—"}</td>
              <td>
                <code>{c.requestId ?? "—"}</code>
              </td>
              <td>{c.durationMs}</td>
              <td className={c.ok ? "ok-text" : "err-text"}>{c.ok ? "OK" : c.message}</td>
            </tr>
          ))}
          {calls.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No calls yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
