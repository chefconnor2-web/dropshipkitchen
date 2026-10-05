"use client";

import { useActionState } from "react";
import { trackLookupAction, type TrackState } from "./actions";

export default function TrackForm({ example }: { example: string }) {
  const [state, action, pending] = useActionState<TrackState, FormData>(trackLookupAction, {});
  return (
    <form action={action} className="trk-form">
      <label>
        Order number
        <input name="number" required placeholder={`e.g. ${example}`} defaultValue={state.number} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
      </label>
      <label>
        Email you ordered with
        <input name="email" type="email" required placeholder="you@company.com" defaultValue={state.email} autoComplete="email" />
      </label>
      {state.error && (
        <p className="notice err" role="alert">
          {state.error}
        </p>
      )}
      <button className="btn primary lg block" disabled={pending}>
        {pending ? "Finding your order…" : "Track order"}
      </button>
    </form>
  );
}
