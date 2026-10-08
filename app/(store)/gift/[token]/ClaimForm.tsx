"use client";

import { useActionState } from "react";
import { claimGiftAction, type ClaimState } from "./actions";

export default function ClaimForm({ token, countries, defaultCountry, item }: { token: string; countries: Array<{ code: string; name: string }>; defaultCountry: string; item: string }) {
  const [state, action, pending] = useActionState<ClaimState, FormData>(claimGiftAction, { n: 0 });
  if (state.done)
    return (
      <div className="gift-done" aria-live="polite">
        <p className="gift-done-title">🎉 It’s yours!</p>
        <p>
          Your {item} is being printed. We’ll email you tracking as soon as it ships (order <code>{state.done}</code>).
        </p>
      </div>
    );
  const v = (k: string, d = "") => state.values?.[k] ?? d;
  return (
    <form action={action} className="gift-claim" key={state.n}>
      <input type="hidden" name="token" value={token} />
      <label>
        Full name
        <input name="name" autoComplete="name" defaultValue={v("name")} required />
      </label>
      <label>
        Street address
        <input name="line1" autoComplete="address-line1" defaultValue={v("line1")} required />
      </label>
      <label>
        Apartment, unit (optional)
        <input name="line2" autoComplete="address-line2" defaultValue={v("line2")} />
      </label>
      <div className="gift-row">
        <label>
          City
          <input name="city" autoComplete="address-level2" defaultValue={v("city")} required />
        </label>
        <label>
          Province / state
          <input name="state" autoComplete="address-level1" defaultValue={v("state")} />
        </label>
      </div>
      <div className="gift-row">
        <label>
          Postal code
          <input name="postal" autoComplete="postal-code" defaultValue={v("postal")} required />
        </label>
        <label>
          Country
          <select name="country" autoComplete="country" defaultValue={v("country", defaultCountry)}>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Phone (for the courier)
        <input name="phone" type="tel" autoComplete="tel" defaultValue={v("phone")} required />
      </label>
      {state.error && <p className="notice err">{state.error}</p>}
      <button className="btn primary lg" disabled={pending}>
        {pending ? "Saving…" : "Send it to me, free"}
      </button>
      <p className="muted small">Free, nothing to pay. We only use your address to ship this gift.</p>
    </form>
  );
}
