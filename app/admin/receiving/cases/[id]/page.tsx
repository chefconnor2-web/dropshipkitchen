import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { labelReaderConfigured } from "@/lib/config";
import { Flash, fmtTime } from "@/components/admin";
import { CONDITIONS, isCondition } from "@/lib/receiving/conditions";
import { dayInput, fmtDay } from "@/lib/receiving/dates";
import { addConditionPhotos, deleteCase, deletePhoto, saveCase, scanExpiry } from "../../actions";
import { PhotoCapture } from "../../PhotoCapture";
import { ExpiryPill } from "../../ui";

const SOURCE: Record<string, string> = { LABEL: "read from the case sticker", PHOTO: "read from the product photo", MANUAL: "entered by hand" };
const KIND: Record<string, string> = { LABEL: "Case label", EXPIRY: "Product date", CONDITION: "Condition" };

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const c = await prisma.receivedCase.findUnique({
    where: { id },
    include: { delivery: true, photos: { orderBy: { createdAt: "asc" } } },
  });
  if (!c) notFound();
  const reader = labelReaderConfigured();
  const conditionLabel = isCondition(c.condition) ? CONDITIONS[c.condition] : c.condition;

  // Ready-to-send credit request for the distributor rep.
  const claim =
    c.condition === "OK"
      ? null
      : [
          `Credit request — ${c.delivery.supplier} delivery received ${fmtDay(c.delivery.receivedAt)}${c.delivery.invoiceNumber ? `, invoice ${c.delivery.invoiceNumber}` : ""}`,
          `Item: ${[c.itemCode && `#${c.itemCode}`, c.description, c.packSize].filter(Boolean).join(" ") || "(see label photo)"}`,
          [c.brand && `Brand: ${c.brand}`, c.lotCode && `Lot: ${c.lotCode}`, c.gtin && `GTIN: ${c.gtin}`, c.packDate && `Packed: ${fmtDay(c.packDate)}`]
            .filter(Boolean)
            .join(" · "),
          `Problem: ${conditionLabel}${c.issueQuantity ? ` — ${c.issueQuantity} of ${c.quantity} case${c.quantity === 1 ? "" : "s"}` : ""}`,
          c.issueNote && `Details: ${c.issueNote}`,
          `${c.photos.length} photo(s) of the case label and product on file.`,
        ]
          .filter(Boolean)
          .join("\n");

  return (
    <>
      <div className="small muted">
        <Link href="/admin/receiving">Receiving</Link> /{" "}
        <Link href={`/admin/receiving/${c.deliveryId}`}>
          {c.delivery.supplier} · {fmtTime(c.delivery.receivedAt)}
        </Link>{" "}
        /
      </div>
      <h1>{c.description ?? "New box"}</h1>
      <div className="row gap">
        <ExpiryPill date={c.expiryDate} />
        {c.condition !== "OK" && <span className="pill pill-issue">{conditionLabel}</span>}
      </div>
      <Flash notice={sp.notice} error={sp.error} />

      <div className="case-grid">
        <section>
          <div className="photo-grid">
            {c.photos.map((p) => (
              <figure key={p.id} className="photo-tile">
                <a href={`/admin/receiving/photo/${p.id}`} target="_blank">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/admin/receiving/photo/${p.id}`} alt={KIND[p.kind] ?? p.kind} loading="lazy" />
                </a>
                <figcaption className="row between small">
                  <span className="muted">{KIND[p.kind] ?? p.kind}</span>
                  <form action={deletePhoto}>
                    <input type="hidden" name="photoId" value={p.id} />
                    <button className="link-btn">remove</button>
                  </form>
                </figcaption>
              </figure>
            ))}
            {c.photos.length === 0 && <p className="muted small">No photos.</p>}
          </div>
          {c.labelText && (
            <details className="raw">
              <summary className="small">Everything read off the sticker</summary>
              <pre>{c.labelText}</pre>
            </details>
          )}
          {c.barcodesJson && (
            <details className="raw">
              <summary className="small">Barcodes decoded on the phone</summary>
              <pre>{(JSON.parse(c.barcodesJson) as string[]).map((b) => b.replace(/\u001d/g, "<GS>")).join("\n")}</pre>
            </details>
          )}
        </section>

        <section>
          <form action={saveCase} className="card pad">
            <input type="hidden" name="id" value={c.id} />

            <h3>EXPIRY DATE</h3>
            <div className="row gap expiry-row">
              <label className="grow">
                Best by / use by
                <input type="date" name="expiryDate" defaultValue={dayInput(c.expiryDate)} />
              </label>
              <PhotoCapture
                action={scanExpiry}
                hidden={{ caseId: c.id }}
                label="📷 Snap the date"
                pendingText={reader ? "Reading date…" : "Saving photo…"}
                camera
              />
            </div>
            {c.expiryDate && (
              <p className="small muted">
                {c.expiryRawText && <>Printed “{c.expiryRawText}” · </>}
                {c.expirySource ? SOURCE[c.expirySource] : ""}
              </p>
            )}

            <h3>FROM THE CASE STICKER</h3>
            <label>
              Description
              <input name="description" defaultValue={c.description ?? ""} />
            </label>
            <div className="row gap">
              <label className="grow">
                Item #
                <input name="itemCode" defaultValue={c.itemCode ?? ""} inputMode="numeric" />
              </label>
              <label className="grow">
                Pack / size
                <input name="packSize" defaultValue={c.packSize ?? ""} />
              </label>
            </div>
            <div className="row gap">
              <label className="grow">
                Brand
                <input name="brand" defaultValue={c.brand ?? ""} />
              </label>
              <label className="grow">
                Lot
                <input name="lotCode" defaultValue={c.lotCode ?? ""} />
              </label>
            </div>
            <div className="row gap">
              <label className="grow">
                GTIN
                <input name="gtin" defaultValue={c.gtin ?? ""} inputMode="numeric" />
              </label>
              <label className="grow">
                Pack date
                <input type="date" name="packDate" defaultValue={dayInput(c.packDate)} />
              </label>
              <label className="qty-label">
                Boxes
                <input type="number" name="quantity" min={1} defaultValue={c.quantity} />
              </label>
            </div>

            <h3>CONDITION</h3>
            <div className="row gap">
              <label className="grow">
                On arrival
                <select name="condition" defaultValue={c.condition}>
                  {Object.entries(CONDITIONS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="qty-label">
                Boxes affected
                <input type="number" name="issueQuantity" min={1} defaultValue={c.issueQuantity ?? ""} />
              </label>
            </div>
            <label>
              What&apos;s wrong (if not OK)
              <textarea name="issueNote" rows={2} defaultValue={c.issueNote ?? ""} placeholder="e.g. mould on most berries in 4 of 8 clamshells" />
            </label>

            <div className="row gap">
              <button className="btn primary" name="next" value="1">
                Save &amp; snap next box
              </button>
              <button className="btn">Save</button>
            </div>
          </form>

          <div className="card pad condition-photos">
            <h3>CONDITION PHOTOS</h3>
            <p className="small muted">Mould, crushed boxes, temperature readings — anything you&apos;ll want for a credit.</p>
            <PhotoCapture action={addConditionPhotos} hidden={{ caseId: c.id }} label="📷 Add photos" pendingText="Uploading…" multiple />
          </div>

          {claim && (
            <div className="card pad">
              <h3>CREDIT REQUEST</h3>
              <p className="small muted">Copy this to your rep, along with the photos.</p>
              <textarea readOnly rows={7} value={claim} className="claim" />
            </div>
          )}

          {c.extractionError && <p className="notice err small">Sticker reader: {c.extractionError}</p>}

          <form action={deleteCase} className="delete-form">
            <input type="hidden" name="id" value={c.id} />
            <button className="btn small danger">Remove this box</button>
          </form>
        </section>
      </div>
    </>
  );
}
