import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";

export default async function ProductsPage() {
  const products = await prisma.product.findMany({
    orderBy: { createdAt: "desc" },
    include: { variants: { include: { offer: true } }, supplierProduct: true, images: { take: 1, orderBy: { position: "asc" } } },
  });
  return (
    <>
      <h1>Products</h1>
      <p className="muted">
        Import real products from <Link href="/admin/suppliers/cj">CJ search</Link>, then rebrand, price and publish.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th></th>
            <th>Our product</th>
            <th>Internal SKU</th>
            <th>Price</th>
            <th>Variants</th>
            <th>Status</th>
            <th>Supplier</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => {
            const prices = p.variants.map((v) => v.priceCents);
            return (
              <tr key={p.id}>
                <td>{p.images[0] && <img className="thumb" src={`/media/${p.images[0].id}`} alt="" />}</td>
                <td>
                  <Link href={`/admin/products/${p.id}`}>{p.title}</Link>
                  <div className="muted small">/products/{p.slug}</div>
                </td>
                <td>
                  <code>{p.internalSku}</code>
                </td>
                <td>{prices.length ? formatMoney(Math.min(...prices)) : "—"}</td>
                <td>
                  {p.variants.filter((v) => v.enabled).length}/{p.variants.length}
                </td>
                <td>
                  <span className={`pill ${p.status === "PUBLISHED" ? "pill-ok" : ""}`}>{p.status}</span>
                </td>
                <td className="small">
                  CJ · PID <code>{p.supplierProduct?.cjProductId ?? "—"}</code>
                </td>
              </tr>
            );
          })}
          {products.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Nothing imported yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
