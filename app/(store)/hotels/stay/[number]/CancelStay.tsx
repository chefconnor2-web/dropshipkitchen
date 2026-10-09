"use client";

import { useActionState, useState } from "react";
import { cancelStayAction, type CancelState } from "../../actions";
import { stayPrice } from "@/lib/flights-shared";

/** Two taps: Cancel booking, then confirm. Shows what comes back first (what the hotel refunds; our fee is kept). */
export default function CancelStay({ number, token, currency, feeCents }: { number: string; token: string; currency: string; feeCents: number }) {
  const [asking, setAsking] = useState(false);
  const [state, action, pending] = useActionState<CancelState, FormData>(cancelStayAction, {});
  if (state.done)
    return (
      <p className="notice">
        Cancelled. {state.refundCents ? `${stayPrice({ priceCents: state.refundCents, currency })} is on its way back to your card.` : "The hotel didn't refund anything under its policy."} We’ve emailed you the details.
      </p>
    );
  return (
    <section className="trip-cancel">
      {!asking ? (
        <button type="button" className="btn" onClick={() => setAsking(true)}>
          Cancel booking
        </button>
      ) : (
        <form action={action}>
          <input type="hidden" name="number" value={number} />
          <input type="hidden" name="t" value={token} />
          <p>
            Cancel this stay? You’ll get back what the hotel refunds under its cancellation policy (usually everything before the free-cancellation deadline). Our {stayPrice({ priceCents: feeCents, currency })} service fee isn’t refundable.
          </p>
          <div className="trip-cancel-row">
            <button className="btn danger" disabled={pending}>
              {pending ? "Cancelling…" : "Yes, cancel"}
            </button>
            <button type="button" className="btn" onClick={() => setAsking(false)} disabled={pending}>
              Keep my booking
            </button>
          </div>
        </form>
      )}
      {state.error && <p className="notice err">{state.error}</p>}
    </section>
  );
}
