"use client";

import { useActionState } from "react";
import { bookHotelAction, type HotelBookState } from "../../actions";
import { stayPrice } from "@/lib/flights-shared";

export default function BookForm({ offerId, priceCents, currency }: { offerId: string; priceCents: number; currency: string }) {
  const [state, action, pending] = useActionState<HotelBookState, FormData>(bookHotelAction, { shownCents: priceCents, n: 0 });
  const v = (k: string) => state.values?.[k] ?? "";
  return (
    <form action={action} className="fl-form" key={state.n}>
      <input type="hidden" name="offerId" value={offerId} />
      <fieldset className="fl-pax">
        <legend>Lead guest</legend>
        <p className="muted small">The name the hotel will look for at check-in, as on their ID.</p>
        <div className="fl-row">
          <label>
            First name
            <input name="firstName" defaultValue={v("firstName")} autoComplete="given-name" required maxLength={60} />
          </label>
          <label>
            Last name
            <input name="lastName" defaultValue={v("lastName")} autoComplete="family-name" required maxLength={60} />
          </label>
        </div>
      </fieldset>
      <fieldset className="fl-pax">
        <legend>Contact</legend>
        <div className="fl-row">
          <label>
            Email
            <input type="email" name="email" defaultValue={v("email")} autoComplete="email" required />
          </label>
          <label>
            Phone
            <input type="tel" name="phone" defaultValue={v("phone")} autoComplete="tel" placeholder="+1 604 555 0100" required />
          </label>
        </div>
      </fieldset>
      {state.error && (
        <p className="notice err" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn primary fl-pay" disabled={pending}>
        {pending ? "Holding your room…" : `Pay ${stayPrice({ priceCents: state.shownCents, currency })}`}
      </button>
      <p className="muted small">We hold the room, then you pay securely with Stripe. The booking is confirmed right after payment; if the hotel can’t confirm, you’re refunded in full.</p>
    </form>
  );
}
