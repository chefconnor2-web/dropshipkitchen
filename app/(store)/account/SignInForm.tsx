"use client";

import { useActionState } from "react";
import { requestSignIn, type SignInState } from "../actions";

export default function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(requestSignIn, null);
  return (
    <form action={action} className="signin-form">
      <label htmlFor="signin-email">Email</label>
      <div className="signin-row">
        <input id="signin-email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
        <button className="btn primary" disabled={pending}>
          {pending ? "Sending…" : "Email me a sign-in link"}
        </button>
      </div>
      {state && <p className={state.ok ? "notice ok" : "notice err"}>{state.message}</p>}
    </form>
  );
}
