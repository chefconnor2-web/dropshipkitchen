"use client";

// My details: the traveller details saved for booking forms (flights, hotels, the rental car driver), and the
// shopper's own Anthropic API key that Neon runs on (bring your own key). Saved encrypted, per account or this
// browser; never card details. Data: /api/profile (lib/traveller.ts) and /api/ai-key (lib/ai-key.ts).

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
    title: "Address",
    fields: [
      { k: "addressLine1", label: "Street address", auto: "address-line1" },
      { k: "addressLine2", label: "Apartment, suite (optional)", auto: "address-line2" },
      { k: "city", label: "City", auto: "address-level2" },
      { k: "region", label: "Province or state", auto: "address-level1" },
      { k: "postalCode", label: "Postal code", auto: "postal-code" },
      { k: "country", label: "Country code", placeholder: "CA", auto: "country" },
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

/** Bring your own key: Neon's chats run on the shopper's own Anthropic account. */
function AiKeySection() {
  const [state, setState] = useState<{ hasKey: boolean; hint: string | null; storeKey: boolean } | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/ai-key", { cache: "no-store" })
      .then((r) => r.json())
      .then(setState)
      .catch(() => setState({ hasKey: false, hint: null, storeKey: false }));
  }, []);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const key = String(new FormData(form).get("key") ?? "").trim();
    if (!key) return;
    setBusy(true);
    setStatus({ ok: true, text: "Checking your key with Anthropic…" });
    const r = await fetch("/api/ai-key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }).catch(() => null);
    const d = r ? ((await r.json().catch(() => ({}))) as { hasKey?: boolean; hint?: string; error?: string }) : { error: "Couldn't reach the server." };
    setBusy(false);
    if (d.hasKey) {
      form.reset();
      setState((s) => ({ hasKey: true, hint: d.hint ?? null, storeKey: s?.storeKey ?? false }));
      setStatus({ ok: true, text: "Saved. Neon now runs on your Anthropic account." });
    } else setStatus({ ok: false, text: d.error ?? "Couldn't save the key. Try again." });
  }

  async function remove() {
    setBusy(true);
    await fetch("/api/ai-key", { method: "DELETE" }).catch(() => null);
    setBusy(false);
    setState((s) => ({ hasKey: false, hint: null, storeKey: s?.storeKey ?? false }));
    setStatus({ ok: true, text: "Removed your key." });
  }

  return (
    <form className="dp-form dp-key" onSubmit={save}>
      <fieldset className="dp-group">
        <legend>AI key</legend>
        <p className="dp-note">
          Neon runs on your own Anthropic API key, billed to your Anthropic account. Create one at{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            console.anthropic.com
          </a>
          . Using Chit from Claude or ChatGPT as a connector needs no key.
        </p>
        {state?.hasKey && <p className="dp-note dp-key-on">Your key {state.hint} is saved and in use.</p>}
        <label className="dp-field">
          <span>{state?.hasKey ? "Replace your key" : "Anthropic API key"}</span>
          <input name="key" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" />
        </label>
        {status && (
          <p className={`dp-status${status.ok ? "" : " is-bad"}`} role="status">
            {status.text}
          </p>
        )}
        <button className="cx-btn cx-btn-primary dp-save" disabled={busy || !state}>
          {busy ? "Checking…" : "Save key"}
        </button>
        {state?.hasKey && (
          <button type="button" className="dp-forget" disabled={busy} onClick={remove}>
            Remove my key
          </button>
        )}
      </fieldset>
    </form>
  );
}

export default function DetailsPanel({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<TravellerProfileData | null>(null);
  const [status, setStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [testMode, setTestMode] = useState(false);

  useEffect(() => {
    fetch("/api/profile", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { profile: TravellerProfileData; testMode?: boolean }) => {
        setP(d.profile ?? {});
        setTestMode(!!d.testMode);
      })
      .catch(() => setP({}));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await put(Object.fromEntries(new FormData(e.currentTarget).entries()));
  }

  async function put(body: Record<string, unknown>) {
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
          <AiKeySection />
          <p className="tp-empty">Saved for your flight, hotel and rental car bookings, so the forms fill themselves and Neon can fill in the car driver form (after you approve). Encrypted. Never your card.</p>
          {testMode && (
            <button type="button" className="cx-btn dp-test" disabled={saving} onClick={() => put({ useTestDetails: true })}>
              🧪 Fill test details (chefconnor2@gmail.com, mock passport and address)
            </button>
          )}
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
