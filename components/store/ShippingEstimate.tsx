"use client";

import { useActionState } from "react";
import { estimateShipping, type ShipEstimateState } from "@/app/(store)/actions";

const COUNTRIES = [
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
  ["AU", "Australia"],
  ["NZ", "New Zealand"],
  ["IE", "Ireland"],
] as const;

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** Live shipping price for the selected option, before it goes in the cart. */
export default function ShippingEstimate({ variantId, country, zip }: { variantId: string | null; country: string; zip: string }) {
  const [state, action, pending] = useActionState<ShipEstimateState, FormData>(estimateShipping, null);
  return (
    <section className="ship-est" aria-label="Shipping estimate">
      <p className="ship-est-title">Shipping to you</p>
      <form action={action}>
        <input type="hidden" name="variantId" value={variantId ?? ""} />
        <label className="sr-only" htmlFor="est-country">
          Country
        </label>
        <select id="est-country" name="country" defaultValue={country}>
          {COUNTRIES.map(([c, n]) => (
            <option key={c} value={c}>
              {n}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="est-zip">
          ZIP or postcode
        </label>
        <input id="est-zip" name="zip" defaultValue={zip} placeholder="ZIP" autoComplete="postal-code" />
        <button className="btn" disabled={!variantId || pending}>
          {pending ? "Checking…" : "Get price"}
        </button>
      </form>
      {state?.ok && (
        <ul className="ship-est-list" aria-live="polite">
          {state.tiers.map((t) => (
            <li key={t.key}>
              <span>
                <strong>{t.label}</strong> <span className="muted">· {t.days}</span>
              </span>
              <span className="price">{money(t.cents)}</span>
            </li>
          ))}
        </ul>
      )}
      {state && !state.ok && (
        <p className="ship-est-err" role="alert">
          {state.message}
        </p>
      )}
    </section>
  );
}
