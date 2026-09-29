import { cjStatus } from "@/lib/cj/status";
import { testCjConnection } from "@/app/admin/actions";

export function fmtTime(d: Date | null | undefined) {
  if (!d) return "never";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "medium" }).format(d);
}

export function Flash({ notice, error }: { notice?: string; error?: string }) {
  return (
    <>
      {notice && <p className="notice ok">{notice}</p>}
      {error && <p className="notice err">{error}</p>}
    </>
  );
}

/** Visual distinction required by the proof: supplier (live API) data vs our storefront data. */
export function Source({ kind }: { kind: "live" | "cached" | "ours" | "snapshot" }) {
  const label = {
    live: "LIVE CJ API DATA",
    cached: "CJ API DATA (CACHED)",
    ours: "OUR STOREFRONT DATA",
    snapshot: "IMMUTABLE ORDER SNAPSHOT",
  }[kind];
  return <span className={`src src-${kind}`}>{label}</span>;
}

export async function CjStatusPanel({ back }: { back: string }) {
  const s = await cjStatus();
  return (
    <div className="card pad status-panel">
      <div className="row between">
        <div>
          <div className="muted small">CJ API CONNECTION</div>
          {s.state === "CONNECTED" && <div className="big ok-text">● Connected</div>}
          {s.state === "ERROR" && <div className="big err-text">● Not Connected</div>}
          {s.state === "NOT_CONFIGURED" && <div className="big err-text">● Not Connected</div>}
          {s.state === "UNVERIFIED" && <div className="big warn-text">● Not yet verified</div>}
        </div>
        <form action={testCjConnection}>
          <input type="hidden" name="back" value={back} />
          <button className="btn" disabled={s.state === "NOT_CONFIGURED"}>
            Test connection
          </button>
        </form>
      </div>
      <div className="small muted">
        {s.state === "NOT_CONFIGURED" && "CJ_API_KEY is not set in the server environment."}
        {s.state === "UNVERIFIED" && "API key present; no call made yet."}
        {s.state === "CONNECTED" && (
          <>
            Last successful call <code>{s.path}</code> at {fmtTime(s.at)}
            {s.requestId && (
              <>
                {" "}
                · CJ requestId <code>{s.requestId}</code>
              </>
            )}
          </>
        )}
        {s.state === "ERROR" && (
          <>
            Last call <code>{s.path}</code> failed at {fmtTime(s.at)}: {s.message}
          </>
        )}
      </div>
      <div className="small muted">Endpoint: developers.cjdropshipping.com/api2.0/v1 (official CJ API V2)</div>
    </div>
  );
}
