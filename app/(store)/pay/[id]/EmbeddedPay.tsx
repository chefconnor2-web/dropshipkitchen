"use client";

import { useEffect, useRef, useState } from "react";

type StripeLike = { initEmbeddedCheckout: (o: { fetchClientSecret: () => Promise<string> }) => Promise<{ mount: (el: HTMLElement) => void; destroy: () => void }> };

/** Stripe's embedded checkout form. The card is typed into Stripe's own frame; Chit never sees it. */
export default function EmbeddedPay({ clientSecret, publishableKey }: { clientSecret: string; publishableKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(publishableKey ? null : "Payments aren't set up yet (missing publishable key).");
  useEffect(() => {
    if (!publishableKey) return;
    let gone = false;
    let destroy: (() => void) | null = null;
    const start = async () => {
      const w = window as unknown as { Stripe?: (k: string) => StripeLike };
      if (!w.Stripe)
        await new Promise<void>((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://js.stripe.com/v3/";
          s.onload = () => res();
          s.onerror = () => rej(new Error("load"));
          document.head.appendChild(s);
        });
      const checkout = await w.Stripe!(publishableKey).initEmbeddedCheckout({ fetchClientSecret: async () => clientSecret });
      if (gone) return checkout.destroy();
      destroy = () => checkout.destroy();
      checkout.mount(box.current!);
    };
    start().catch(() => setError("Couldn't load the payment form. Refresh to try again."));
    return () => {
      gone = true;
      destroy?.();
    };
  }, [clientSecret, publishableKey]);
  return error ? <p className="notice err">{error}</p> : <div ref={box} />;
}
