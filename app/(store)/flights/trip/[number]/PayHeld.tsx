"use client";

import { useActionState } from "react";
import { payHeldAction } from "../../actions";

/** A held fare's Pay button: today's price for the hold, then Stripe Checkout. */
export default function PayHeld({ number, token, label }: { number: string; token: string; label: string }) {
  const [state, action, pending] = useActionState<{ error?: string }, FormData>(payHeldAction, {});
  return (
    <form action={action} className="fl-payheld">
      <input type="hidden" name="number" value={number} />
      <input type="hidden" name="t" value={token} />
      <button className="btn primary lg block" disabled={pending}>
        {pending ? "Checking the fare…" : label}
      </button>
      {state.error && (
        <p className="fl-err" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
