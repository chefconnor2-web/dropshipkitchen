"use client";

import { useActionState, useState } from "react";
import { sendSignInCode, verifySignInCode, type SignInState } from "../actions";

/** Email → 6-digit code → signed in. */
export default function SignInForm({ next = "/account" }: { next?: string }) {
  const [sent, send, sending] = useActionState<SignInState, FormData>(sendSignInCode, null);
  const [checked, verify, verifying] = useActionState<SignInState, FormData>(verifySignInCode, null);
  const [changing, setChanging] = useState(false);
  const email = sent?.step === "code" ? sent.email : undefined;

  if (!email || changing)
    return (
      <form action={(f) => (setChanging(false), send(f))} className="signin-form">
        <input type="hidden" name="next" value={next} />
        <label htmlFor="signin-email">Email</label>
        <div className="signin-row">
          <input id="signin-email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" defaultValue={sent?.email} />
          <button className="btn primary" disabled={sending}>
            {sending ? "Sending…" : "Email me a code"}
          </button>
        </div>
        {sent?.message && !sent.ok && <p className="notice err">{sent.message}</p>}
      </form>
    );

  const error = checked && !checked.ok ? checked.message : null;
  return (
    <div className="signin-form">
      <form action={verify}>
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="email" value={email} />
        <p className="notice ok">{sent?.message}</p>
        <label htmlFor="signin-code">Sign-in code</label>
        <div className="signin-row">
          <input
            id="signin-code"
            name="code"
            required
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            placeholder="123456"
            className="signin-code"
          />
          <button className="btn primary" disabled={verifying}>
            {verifying ? "Checking…" : "Sign in"}
          </button>
        </div>
        {error && <p className="notice err">{error}</p>}
      </form>
      <div className="muted small signin-again">
        No email? Check spam, or{" "}
        <form action={send} className="inline-form">
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="email" value={email} />
          <button className="link-btn small" disabled={sending}>
            send a new code
          </button>
        </form>{" "}
        ·{" "}
        <button type="button" className="link-btn small" onClick={() => setChanging(true)}>
          use another email
        </button>
      </div>
    </div>
  );
}
