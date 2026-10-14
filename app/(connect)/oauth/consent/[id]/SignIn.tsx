"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { sendSignInCode, verifySignInCode, type SignInState } from "@/app/(store)/actions";

const LEN = 6;
const RESEND_S = 30;

/** Email, then a 6-digit code typed (or pasted) into six boxes; it signs in as soon as the sixth digit lands. */
export default function SignIn({ next }: { next: string }) {
  const [sent, send, sending] = useActionState<SignInState, FormData>(sendSignInCode, null);
  const [checked, verify, verifying] = useActionState<SignInState, FormData>(verifySignInCode, null);
  const [changing, setChanging] = useState(false);
  const email = sent?.step === "code" && sent.ok ? sent.email : undefined;

  if (!email || changing)
    return (
      <form action={(f) => (setChanging(false), send(f))} className="cn-form">
        <input type="hidden" name="next" value={next} />
        <label className="cn-label" htmlFor="cn-email">
          Email
        </label>
        <input id="cn-email" className="cn-input" name="email" type="email" required autoFocus autoComplete="email" inputMode="email" placeholder="you@example.com" defaultValue={sent?.email} aria-invalid={!!(sent && !sent.ok)} aria-describedby={sent && !sent.ok ? "cn-email-error" : undefined} />
        {sent && !sent.ok && sent.message ? (
          <p className="cn-error" id="cn-email-error" role="alert">
            {sent.message}
          </p>
        ) : null}
        <button className="cn-btn primary" disabled={sending}>
          {sending ? <span className="cn-spin" aria-hidden /> : null}
          {sending ? "Sending code…" : "Continue with email"}
        </button>
      </form>
    );

  return <CodeStep email={email} next={next} verify={verify} verifying={verifying} error={checked && !checked.ok ? checked.message : undefined} resend={send} resending={sending} onChange={() => setChanging(true)} />;
}

function CodeStep({
  email,
  next,
  verify,
  verifying,
  error,
  resend,
  resending,
  onChange,
}: {
  email: string;
  next: string;
  verify: (f: FormData) => void;
  verifying: boolean;
  error?: string;
  resend: (f: FormData) => void;
  resending: boolean;
  onChange: () => void;
}) {
  const [digits, setDigits] = useState<string[]>(Array(LEN).fill(""));
  const [wait, setWait] = useState(RESEND_S);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const form = useRef<HTMLFormElement>(null);
  const code = digits.join("");

  useEffect(() => {
    boxes.current[0]?.focus();
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  // A wrong code: clear the boxes and start again from the first.
  useEffect(() => {
    if (!error) return;
    setDigits(Array(LEN).fill(""));
    boxes.current[0]?.focus();
  }, [error]);

  const fill = (from: number, text: string) => {
    const got = text.replace(/\D/g, "").slice(0, LEN - from).split("");
    if (!got.length) return;
    const nextDigits = [...digits];
    got.forEach((d, i) => (nextDigits[from + i] = d));
    setDigits(nextDigits);
    const at = Math.min(LEN - 1, from + got.length);
    boxes.current[at]?.focus();
    if (nextDigits.every(Boolean)) setTimeout(() => form.current?.requestSubmit(), 0);
  };

  return (
    <div className="cn-form">
      <p className="cn-sent">
        We sent a code to <b>{email}</b>
        <button type="button" className="cn-link" onClick={onChange}>
          Change
        </button>
      </p>
      <form action={verify} ref={form}>
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="code" value={code} />
        <fieldset className={`cn-otp${error ? " bad" : ""}`} disabled={verifying}>
          <legend className="cn-label">Code from your email</legend>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                boxes.current[i] = el;
              }}
              value={d}
              aria-label={`Digit ${i + 1}`}
              aria-invalid={!!error}
              aria-describedby={error ? "cn-code-error" : undefined}
              inputMode="numeric"
              autoComplete={i === 0 ? "one-time-code" : "off"}
              maxLength={i === 0 ? LEN : 1}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return setDigits((ds) => ds.map((x, j) => (j === i ? "" : x)));
                fill(i, v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !digits[i] && i > 0) {
                  e.preventDefault();
                  setDigits((ds) => ds.map((x, j) => (j === i - 1 ? "" : x)));
                  boxes.current[i - 1]?.focus();
                }
                if (e.key === "ArrowLeft" && i > 0) boxes.current[i - 1]?.focus();
                if (e.key === "ArrowRight" && i < LEN - 1) boxes.current[i + 1]?.focus();
              }}
              onPaste={(e) => {
                e.preventDefault();
                fill(i, e.clipboardData.getData("text"));
              }}
              onFocus={(e) => e.target.select()}
            />
          ))}
        </fieldset>
        {error ? (
          <p className="cn-error" id="cn-code-error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="cn-btn primary" disabled={verifying || code.length < LEN}>
          {verifying ? <span className="cn-spin" aria-hidden /> : null}
          {verifying ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <form
        action={(f) => {
          setWait(RESEND_S);
          resend(f);
        }}
        className="cn-resend"
      >
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="email" value={email} />
        <span>Didn’t get it? Check spam, or</span>
        <button className="cn-link" disabled={wait > 0 || resending}>
          {wait > 0 ? `resend in ${wait}s` : resending ? "sending…" : "send a new code"}
        </button>
      </form>
    </div>
  );
}
