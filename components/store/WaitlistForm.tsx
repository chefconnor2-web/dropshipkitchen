"use client";

import { useActionState } from "react";
import { joinWaitlist, type WaitlistState } from "@/app/(store)/actions";

export default function WaitlistForm({ platform, productId, cta }: { platform: string; productId: string; cta: string }) {
  const [state, action, pending] = useActionState<WaitlistState, FormData>(joinWaitlist, null);
  if (state?.ok) return <p className="wl-done" role="status">{state.message}</p>;
  return (
    <form action={action} className="wl-form">
      <input type="hidden" name="platform" value={platform} />
      <input type="hidden" name="productId" value={productId} />
      <label className="sr-only" htmlFor={`wl-${productId}`}>
        Email
      </label>
      <input id={`wl-${productId}`} name="email" type="email" required autoComplete="email" placeholder="you@email.com" />
      <button className="btn" disabled={pending}>
        {pending ? "Saving…" : cta}
      </button>
      {state && !state.ok && (
        <p className="wl-err" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
