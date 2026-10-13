"use client";

// My details: the traveller details saved for booking forms (flights, hotels, the rental car driver). Saved
// encrypted, per account or this browser; never card details. Data: /api/profile (lib/traveller.ts).

import { useEffect, useState } from "react";
import type { TravellerProfileData } from "@/lib/traveller";

type Field = { k: keyof TravellerProfileData; label: string; type?: string; auto?: string; options?: Array<[string, string]>; placeholder?: string };
const GROUPS: Array<{ title: string; fields: Field[] }> = [
  {
    title: "Traveller",
    fields: [
      { k: "title", label: "Title", options: [["", "Choose"], ["mr", "Mr"], ["ms", "Ms"], ["mrs", "Mrs"], ["miss", "Miss"], ["dr", "Dr"]] },
      { k: "gender", label: "Gender", options: [["", "Choose"], ["f", "Female"], ["m", "Male"]] },
      { k: "givenName", label: "First and middle names", auto: "given-name" },
      { k: "familyName", label: "Last name", auto: "family-name" },
      { k: "bornOn", label: "Date of birth", type: "date", auto: "bday" },
    ],
  },
  {
    title: "Contact",
    fields: [
      { k: "email", label: "Email", type: "email", auto: "email" },
      { k: "phone", label: "Mobile phone", type: "tel", auto: "tel", placeholder: "+1 416 555 0123" },
    ],
  },
  {
    title: "Passport",
    fields: [
      { k: "passportNumber", label: "Passport number", auto: "off" },
      { k: "passportCountry", label: "Issued by (country code)", placeholder: "CA", auto: "off" },
      { k: "passportExpiry", label: "Expires", type: "date" },
    ],
  },
];

export default function DetailsPanel({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<TravellerProfileData | null>(null);
  const [status, setStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/profile", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { profile: TravellerProfileData }) => setP(d.profile ?? {}))
      .catch(() => setP({}));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    setSaving(true);
    setStatus("");
    const r = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? ((await r.json().catch(() => ({}))) as { profile?: TravellerProfileData; error?: string }) : { error: "Couldn't reach the server." };
    setSaving(false);
    if (d.profile) {
      setP(d.profile);
      setStatus("Saved. Booking forms will fill themselves.");
    } else setStatus(d.error ?? "Couldn't save. Try again.");
  }

  async function forget() {
    await fetch("/api/profile", { method: "DELETE" }).catch(() => null);
    setP({});
    setStatus("Deleted your saved details.");
  }

  return (
    <div className="tp-scrim" role="dialog" aria-modal="true" aria-label="My details" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tp">
        <div className="tp-head">
          <span className="tp-title">My details</span>
          <button type="button" className="tp-close" onClick={onClose} aria-label="Close my details">
            ✕
          </button>
        </div>
        <div className="tp-body">
          <p className="tp-empty">Saved for your flight, hotel and rental car bookings, so the forms fill themselves and Neon can fill in the car driver form (after you approve). Encrypted. Never your card.</p>
          {!p ? (
            <p className="tp-empty">Loading…</p>
          ) : (
            <form className="dp-form" onSubmit={save} key={JSON.stringify(p)}>
              {GROUPS.map((g) => (
                <fieldset key={g.title} className="dp-group">
                  <legend>{g.title}</legend>
                  {g.fields.map((f) => (
                    <label key={f.k} className="dp-field">
                      <span>{f.label}</span>
                      {f.options ? (
                        <select name={f.k} defaultValue={p[f.k] ?? ""}>
                          {f.options.map(([v, l]) => (
                            <option key={v} value={v}>
                              {l}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input name={f.k} type={f.type ?? "text"} defaultValue={p[f.k] ?? ""} autoComplete={f.auto} placeholder={f.placeholder} />
                      )}
                    </label>
                  ))}
                </fieldset>
              ))}
              {status && (
                <p className="dp-status" role="status">
                  {status}
                </p>
              )}
              <button className="cx-btn cx-btn-primary dp-save" disabled={saving}>
                {saving ? "Saving…" : "Save my details"}
              </button>
              {Object.keys(p).length > 0 && (
                <button type="button" className="dp-forget" onClick={forget}>
                  Delete my saved details
                </button>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
