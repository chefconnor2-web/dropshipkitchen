"use client";

import { useActionState } from "react";
import { flightCancelAction, type FlightCancelState } from "../../actions";
import { flightPrice } from "@/lib/flights-shared";

/** Step 1: ask the airline what it refunds. Step 2: cancel, once the passenger has seen the quote. */
export default function CancelFlight({ number, token, currency, airline }: { number: string; token: string; currency: string; airline: string }) {
  const [state, action, pending] = useActionState<FlightCancelState, FormData>(flightCancelAction, {});
  const money = (c: number) => flightPrice({ priceCents: c, currency });
  if (state.done)
    return (
      <p className="notice">
        Cancelled. {state.refundCents ? `${money(state.refundCents)} is on its way back to your card.` : `${airline} didn’t refund money for this fare.`} We’ve emailed you the details.
      </p>
    );
  const q = state.quote;
  return (
    <section className="trip-cancel">
      <form action={action}>
        <input type="hidden" name="number" value={number} />
        <input type="hidden" name="t" value={token} />
        {q && <input type="hidden" name="quoteId" value={q.quoteId} />}
        {q && (
          <p>
            {q.refundCents > 0
              ? `${airline} will refund ${money(q.refundCents)}; that comes back to your card. Our service fee isn’t refundable.`
              : q.creditOnly
                ? `${airline} doesn’t refund money for this fare; it gives a credit for a future flight with ${airline} instead.`
                : `${airline} doesn’t refund anything for this fare. Cancelling frees the seat but returns nothing.`}{" "}
            This offer is good for a few minutes.
          </p>
        )}
        <div className="trip-cancel-row">
          <button className={`btn${q ? " danger" : ""}`} disabled={pending}>
            {pending ? (q ? "Cancelling…" : "Checking with the airline…") : q ? "Yes, cancel my flight" : "Cancel flight"}
          </button>
        </div>
      </form>
      {state.error && <p className="notice err">{state.error}</p>}
    </section>
  );
}
