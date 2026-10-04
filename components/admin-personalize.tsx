// Admin: the print-on-demand set-up for one product, with a preview of where the print lands.
import { DEFAULT_PERSONALIZE, parsePersonalizeConfig } from "@/lib/personalize-shared";
import { savePersonalize } from "@/app/admin/actions";

/** Fields in CJ's product JSON that look POD-related, so the merchant can see what CJ says about it. */
export function podHints(rawJson: string | null | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= 12 || depth > 3 || v === null || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      const keyHit = /pod|custom|personal|print|design/i.test(k);
      if (keyHit && val !== null && typeof val === "object") out.push([p, JSON.stringify(val).slice(0, 160)]);
      else if (keyHit || (typeof val === "string" && /\bpod\b|print on demand|customi[sz]/i.test(val) && val.length < 200)) out.push([p, String(val).slice(0, 120)]);
      else if (val !== null && typeof val === "object" && !Array.isArray(val)) walk(val, p, depth + 1);
    }
  };
  try {
    walk(JSON.parse(rawJson || "null"), "", 0);
  } catch {
    /* no hints */
  }
  return out;
}

export default function PersonalizeSettings({
  productId,
  personalizeJson,
  imageId,
  cjRawJson,
}: {
  productId: string;
  personalizeJson: string | null;
  imageId: string | null;
  cjRawJson: string | null;
}) {
  const saved = parsePersonalizeConfig(personalizeJson);
  const c = saved ?? DEFAULT_PERSONALIZE;
  const hints = podHints(cjRawJson);
  const pct = (n: number) => Math.round(n * 1000) / 10;
  return (
    <section className="card pad personalize-admin">
      <div className="row between">
        <h2>Personalization (print on demand)</h2>
        <span className={`pill ${saved ? "pill-ok" : ""}`}>{saved ? "ON" : "OFF"}</span>
      </div>
      <p className="muted small">
        Shoppers upload a photo or type text, see a mock-up, and pay. You review the design on the order before approving; CJ then
        prints it. This only works on CJ print-on-demand products: use the print area name and POD version shown in your CJ POD template.
      </p>
      {hints.length > 0 ? (
        <details>
          <summary className="small">What CJ&apos;s product data says ({hints.length} POD-related fields)</summary>
          <dl className="kv small">
            {hints.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>
                  <code>{k}</code>
                </dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : (
        <p className="small warn-text">CJ&apos;s product data has no print-on-demand fields. Check that this is a CJ POD product before switching this on.</p>
      )}
      <form action={savePersonalize} className="personalize-form">
        <input type="hidden" name="id" value={productId} />
        <label className="row gap">
          <input type="checkbox" name="enabled" defaultChecked={!!saved} /> Shoppers personalize this product
        </label>
        <div className="grid-2">
          <label>
            CJ POD version
            <select name="podVersion" defaultValue={String(c.podVersion)}>
              <option value="2">POD 2.0 (print area + artwork)</option>
              <option value="3">POD 3.0 (artwork + mock-up)</option>
            </select>
          </label>
          <label>
            CJ print area name (POD 2.0)
            <input name="areaName" defaultValue={c.areaName} placeholder="LogoArea" />
          </label>
          <label className="row gap">
            <input type="checkbox" name="allowPhoto" defaultChecked={c.allowPhoto} /> Photo upload
          </label>
          <label className="row gap">
            <input type="checkbox" name="allowText" defaultChecked={c.allowText} /> Custom text
          </label>
          <label>
            Max text length
            <input name="maxTextLength" type="number" min={1} max={200} defaultValue={c.maxTextLength} />
          </label>
          <label>
            Print file size (px, width × height)
            <span className="row gap" style={{ display: "flex" }}>
              <input name="artWidth" type="number" min={200} max={6000} defaultValue={c.artWidth} aria-label="Print width" />
              <input name="artHeight" type="number" min={200} max={6000} defaultValue={c.artHeight} aria-label="Print height" />
            </span>
          </label>
        </div>
        <fieldset>
          <legend className="small">Where the print shows on the main photo (for the shopper&apos;s mock-up), in % of the photo</legend>
          <div className="grid-4">
            {(
              [
                ["boxX", "Left", c.box.x],
                ["boxY", "Top", c.box.y],
                ["boxW", "Width", c.box.w],
                ["boxH", "Height", c.box.h],
              ] as const
            ).map(([name, label, v]) => (
              <label key={name}>
                {label}
                <input name={name} type="number" step="0.5" min={0} max={100} defaultValue={pct(v)} />
              </label>
            ))}
          </div>
        </fieldset>
        {imageId && (
          <div className="print-box-preview" aria-label="Saved print area on the main photo">
            <img src={`/media/${imageId}`} alt="" />
            <span style={{ left: `${c.box.x * 100}%`, top: `${c.box.y * 100}%`, width: `${c.box.w * 100}%`, height: `${c.box.h * 100}%` }} />
          </div>
        )}
        <label>
          Note for shoppers (optional)
          <input name="instructions" defaultValue={c.instructions} placeholder="Square photos work best. Avoid logos you don't own." />
        </label>
        <button className="btn primary">Save personalization</button>
      </form>
    </section>
  );
}
