"use client";

// Shipping for the selected option, shown without a button: a remembered price or an estimate at once,
// then CJ's live price as soon as it arrives. The destination is guessed from the shopper's location
// on their first visit and can be changed here.

import { useEffect, useState, useTransition } from "react";
import { saveDestination } from "@/app/(store)/actions";
import type { ShipView } from "@/lib/ship-view";

const COUNTRIES = [
  ["CA", "Canada"],
  ["US", "United States"],
  ["GB", "United Kingdom"],
  ["AU", "Australia"],
  ["NZ", "New Zealand"],
  ["IE", "Ireland"],
] as const;

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

async function fetchView(variantId: string, mode: "fast" | "live"): Promise<ShipView | null> {
  try {
    const r = await fetch(`/api/shipping?variantId=${encodeURIComponent(variantId)}&mode=${mode}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as ShipView) : null;
  } catch {
    return null;
  }
}

export default function ShippingEstimate({
  variantId,
  country: initialCountry,
  zip: initialZip,
  initial,
}: {
  variantId: string | null;
  country: string;
  zip: string;
  /** The server's fast answer for the first option, so the price is there on first paint. */
  initial?: ShipView | null;
}) {
  const [dest, setDest] = useState({ country: initialCountry, zip: initialZip });
  const [view, setView] = useState<ShipView | null>(initial ?? null);
  const [live, setLive] = useState(initial?.status === "live" || initial?.status === "blocked");
  const [editing, setEditing] = useState(false);
  const [rev, setRev] = useState(0);
  const [saving, startSaving] = useTransition();

  // New option or destination: the fast answer (unless the server sent it), then CJ's live price if needed.
  useEffect(() => {
    if (!variantId) return;
    let alive = true;
    (async () => {
      let v: ShipView | null = rev === 0 && initial ? initial : null;
      if (!v) {
        setLive(false);
        v = await fetchView(variantId, "fast");
        if (!alive) return;
        if (v) setView(v);
      }
      if (v && (v.status === "live" || v.status === "blocked")) return setLive(true);
      const l = await fetchView(variantId, "live");
      if (!alive) return;
      if (l && l.status !== "error") setView(l);
      setLive(true);
    })();
    return () => {
      alive = false;
    };
    // `initial` only matters for the first render of this option.
  }, [variantId, rev]);

  function save(form: FormData) {
    const country = String(form.get("country") || dest.country);
    const zip = String(form.get("zip") || "");
    startSaving(async () => {
      const r = await saveDestination(country, zip);
      if (!r.ok) return;
      setDest({ country, zip });
      setEditing(false);
      setView(null);
      setRev((n) => n + 1);
    });
  }

  const countryName = COUNTRIES.find(([c]) => c === dest.country)?.[1] ?? dest.country;
  const estimate = view?.status === "estimate";
  return (
    <section className="ship-est" aria-label="Shipping estimate">
      <div className="ship-est-head">
        <p className="ship-est-title">
          Shipping to {countryName}
          {dest.zip ? ` ${dest.zip}` : ""}
        </p>
        <button type="button" className="link-btn small" onClick={() => setEditing((e) => !e)}>
          {editing ? "Cancel" : "Change"}
        </button>
      </div>
      {editing && (
        <form action={save} className="ship-est-form">
          <label className="sr-only" htmlFor="est-country">
            Country
          </label>
          <select id="est-country" name="country" defaultValue={dest.country}>
            {COUNTRIES.map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="est-zip">
            ZIP or postcode
          </label>
          <input id="est-zip" name="zip" defaultValue={dest.zip} placeholder="ZIP / postcode" autoComplete="postal-code" />
          <button className="btn" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      )}
      {view && view.tiers.length > 0 ? (
        <ul className="ship-est-list" aria-live="polite">
          {view.tiers.map((t) => (
            <li key={t.key}>
              <span>
                <strong>{t.label}</strong> <span className="muted">· {t.days}</span>
              </span>
              <span className="price">
                {estimate ? "≈ " : ""}
                {money(t.cents)}
              </span>
            </li>
          ))}
        </ul>
      ) : view?.status === "blocked" ? (
        <p className="ship-est-err" role="alert">
          Sorry, this item can’t ship to {countryName}.
        </p>
      ) : !live ? (
        <p className="ship-est-pending muted small">
          <span className="ship-pending-dot" aria-hidden /> Getting the shipping price…
        </p>
      ) : (
        <p className="ship-est-err">We couldn’t get a shipping price right now. It’s confirmed in the cart.</p>
      )}
      {!live && view && view.tiers.length > 0 && (
        <p className="ship-est-note muted small">{estimate ? "Estimate · confirming the exact price…" : "Updating…"}</p>
      )}
    </section>
  );
}
