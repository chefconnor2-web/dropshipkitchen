"use client";

import { useActionState } from "react";
import { bookFlightAction, type BookState } from "../../actions";
import { flightPrice } from "@/lib/flights-shared";
import type { PassengerSlot } from "@/lib/flight-booking";

const KIND = { adult: "Adult", child: "Child", infant: "Infant (on lap)" } as const;

export default function BookForm({
  offerId,
  priceCents,
  currency,
  slots,
  needPassport,
  tripSlug,
}: {
  offerId: string;
  priceCents: number;
  currency: string;
  slots: PassengerSlot[];
  needPassport: boolean;
  /** Joining a friend's shared trip. */
  tripSlug?: string;
}) {
  const [state, action, pending] = useActionState<BookState, FormData>(bookFlightAction, { shownCents: priceCents, n: 0 });
  const v = (k: string) => state.values?.[k] ?? "";
  return (
    <form action={action} className="fl-form" key={state.n}>
      <input type="hidden" name="offerId" value={offerId} />
      {tripSlug && <input type="hidden" name="trip" value={tripSlug} />}
      {slots.map((s, i) => (
        <fieldset key={s.id} className="fl-pax">
          <legend>
            {slots.length > 1 ? `Passenger ${i + 1} · ` : ""}
            {KIND[s.kind]}
            {s.age != null ? ` (age ${s.age})` : ""}
          </legend>
          <p className="muted small">Names exactly as on the passport.</p>
          <div className="fl-row">
            <label>
              Title
              <select name={`title_${i}`} defaultValue={v(`title_${i}`)} required>
                <option value="" disabled>
                  Choose
                </option>
                <option value="mr">Mr</option>
                <option value="ms">Ms</option>
                <option value="mrs">Mrs</option>
                <option value="miss">Miss</option>
                <option value="dr">Dr</option>
              </select>
            </label>
            <label>
              Gender
              <select name={`gender_${i}`} defaultValue={v(`gender_${i}`)} required>
                <option value="" disabled>
                  Choose
                </option>
                <option value="f">Female</option>
                <option value="m">Male</option>
              </select>
            </label>
          </div>
          <div className="fl-row">
            <label>
              First and middle names
              <input name={`given_${i}`} defaultValue={v(`given_${i}`)} required autoComplete={i === 0 ? "given-name" : "off"} />
            </label>
            <label>
              Last name
              <input name={`family_${i}`} defaultValue={v(`family_${i}`)} required autoComplete={i === 0 ? "family-name" : "off"} />
            </label>
          </div>
          <label>
            Date of birth
            <input name={`born_${i}`} type="date" defaultValue={v(`born_${i}`)} required autoComplete={i === 0 ? "bday" : "off"} />
          </label>
          {needPassport && (
            <div className="fl-row fl-row-3">
              <label>
                Passport number
                <input name={`passport_${i}`} defaultValue={v(`passport_${i}`)} required autoComplete="off" />
              </label>
              <label>
                Issued by (country code)
                <input name={`passport_country_${i}`} defaultValue={v(`passport_country_${i}`)} required maxLength={2} placeholder="CA" autoComplete="off" />
              </label>
              <label>
                Expires
                <input name={`passport_expiry_${i}`} type="date" defaultValue={v(`passport_expiry_${i}`)} required />
              </label>
            </div>
          )}
        </fieldset>
      ))}
      <fieldset className="fl-pax">
        <legend>Contact</legend>
        <p className="muted small">Your e-ticket goes to this email. The airline may text this number about delays.</p>
        <div className="fl-row">
          <label>
            Email
            <input name="email" type="email" defaultValue={v("email")} required autoComplete="email" />
          </label>
          <label>
            Mobile phone
            <input name="phone" type="tel" defaultValue={v("phone")} required autoComplete="tel" placeholder="+1 416 555 0123" />
          </label>
        </div>
      </fieldset>
      {state.error && (
        <p className="notice err" role="alert">
          {state.error}
        </p>
      )}
      <div className="fl-total">
        <span>Total</span>
        <strong>{flightPrice({ priceCents: state.shownCents, currency })}</strong>
      </div>
      <button className="btn primary lg block" disabled={pending}>
        {pending ? "Checking the fare…" : `Pay ${flightPrice({ priceCents: state.shownCents, currency })} and book`}
      </button>
      <p className="muted small fl-fine">
        We re-check the fare with the airline before charging. Your ticket is booked the moment payment clears; if the airline can&apos;t confirm it,
        you&apos;re refunded in full automatically.
      </p>
    </form>
  );
}
