import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { labelReaderConfigured } from "@/lib/config";
import { Flash, fmtTime } from "@/components/admin";
import { CONDITIONS, isCondition } from "@/lib/receiving/conditions";
import { addManualCase, deleteDelivery, scanLabels, updateDelivery } from "../actions";
import { PhotoCapture } from "../PhotoCapture";
import { ExpiryPill } from "../ui";

export default async function DeliveryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const delivery = await prisma.receivingDelivery.findUnique({
    where: { id },
    include: {
      cases: {
        orderBy: { createdAt: "desc" },
        include: { photos: { where: { kind: "LABEL" }, take: 1, orderBy: { createdAt: "asc" } } },
      },
    },
  });
  if (!delivery) notFound();
  const boxes = delivery.cases.reduce((n, c) => n + c.quantity, 0);
  const missingExpiry = delivery.cases.filter((c) => !c.expiryDate).length;
  const reading = labelReaderConfigured() ? "Reading sticker…" : "Saving photo…";

  return (
    <>
      <div className="small muted">
        <Link href="/admin/receiving">Receiving</Link> /
      </div>
      <h1>
        {delivery.supplier} delivery · {fmtTime(delivery.receivedAt)}
      </h1>
      <p className="muted">
        {boxes} box{boxes === 1 ? "" : "es"}
        {delivery.invoiceNumber && <> · invoice {delivery.invoiceNumber}</>}
        {delivery.receivedBy && <> · received by {delivery.receivedBy}</>}
        {missingExpiry > 0 && <span className="warn-text"> · {missingExpiry} without an expiry date</span>}
      </p>
      <Flash notice={sp.notice} error={sp.error} />

      <div className="card pad capture-panel" id="snap">
        <h3>ADD A BOX</h3>
        <p className="small muted">Point the camera at the case sticker so the whole label and its barcodes are in frame.</p>
        <div className="row gap">
          <PhotoCapture action={scanLabels} hidden={{ deliveryId: id }} label="📷 Snap box label" pendingText={reading} camera scanBarcodes primary />
          <PhotoCapture action={scanLabels} hidden={{ deliveryId: id }} label="Upload label photos" pendingText={reading} multiple scanBarcodes />
          <form action={addManualCase}>
            <input type="hidden" name="deliveryId" value={id} />
            <button className="btn">Type it in</button>
          </form>
        </div>
      </div>

      <div className="case-list">
        {delivery.cases.map((c) => (
          <Link key={c.id} href={`/admin/receiving/cases/${c.id}`} className="card case-row">
            {c.photos[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/admin/receiving/photo/${c.photos[0].id}`} alt="Case label" className="case-thumb" loading="lazy" />
            ) : (
              <div className="case-thumb img-ph" />
            )}
            <div className="case-body">
              <div className="strong">
                {c.description ?? <span className="muted">No description yet</span>}
                {c.quantity > 1 && <span className="muted"> ×{c.quantity}</span>}
              </div>
              <div className="small muted">
                {[c.itemCode && `#${c.itemCode}`, c.packSize, c.brand, c.lotCode && `lot ${c.lotCode}`].filter(Boolean).join(" · ") || "—"}
              </div>
              <div className="row gap case-tags">
                <ExpiryPill date={c.expiryDate} />
                {c.condition !== "OK" && (
                  <span className="pill pill-issue">{isCondition(c.condition) ? CONDITIONS[c.condition] : c.condition}</span>
                )}
                {c.extractionError && <span className="pill pill-noexp">Sticker not read</span>}
              </div>
            </div>
          </Link>
        ))}
        {delivery.cases.length === 0 && <p className="muted">No boxes yet — snap the first label.</p>}
      </div>

      <details className="card pad delivery-edit">
        <summary>Delivery details</summary>
        <form action={updateDelivery}>
          <input type="hidden" name="id" value={id} />
          <div className="row gap">
            <label className="grow">
              Supplier
              <input name="supplier" defaultValue={delivery.supplier} />
            </label>
            <label className="grow">
              Invoice #
              <input name="invoiceNumber" defaultValue={delivery.invoiceNumber ?? ""} />
            </label>
            <label className="grow">
              Received by
              <input name="receivedBy" defaultValue={delivery.receivedBy ?? ""} />
            </label>
          </div>
          <label>
            Notes
            <textarea name="notes" rows={2} defaultValue={delivery.notes ?? ""} />
          </label>
          <button className="btn">Save</button>
        </form>
        <form action={deleteDelivery} className="delete-form">
          <input type="hidden" name="id" value={id} />
          <button className="btn small danger">Delete delivery and all its boxes</button>
        </form>
      </details>
    </>
  );
}
