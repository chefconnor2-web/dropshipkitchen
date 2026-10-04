"use client";

// The cart's Checkout button: reacts the moment it's tapped while the server confirms stock and
// shipping and opens Stripe.
import { useFormStatus } from "react-dom";

export default function CheckoutButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn primary lg block checkout-btn" disabled={disabled || pending} aria-busy={pending}>
      {pending ? (
        <>
          <span className="ship-pending-dot" aria-hidden /> Opening secure checkout…
        </>
      ) : (
        "Checkout"
      )}
    </button>
  );
}
