"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import { subscribeLite } from "@/app/(store)/actions";
import type { PlanOffer } from "@/lib/plan-offer";

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

function LiteButton() {
  const { pending } = useFormStatus();
  return (
    <button className="pp-btn pp-btn-ghost" disabled={pending}>
      {pending ? "Opening checkout…" : "Start Lite"}
    </button>
  );
}

/**
 * The two plans side by side. The full plan is the recommended, visually dominant choice; Lite is the
 * low-commitment way to keep going. `next` is where a signed-out shopper returns after signing in.
 */
export default function PlanPicker({ offer, next = "/plans", compact = false }: { offer: PlanOffer; next?: string; compact?: boolean }) {
  const perDay = offer.full.priceCents / 30;
  return (
    <div className={`pp ${compact ? "pp-compact" : ""}`}>
      <div className="pp-grid">
        <div className="pp-card pp-card-main">
          <span className="pp-ribbon">Recommended</span>
          <div className="pp-name">Full</div>
          <div className="pp-price">
            <strong>{money(offer.full.priceCents)}</strong>
            <span>/month</span>
          </div>
          <div className="pp-sub">About {money(Math.round(perDay))} a day, with a free mystery box to start</div>
          <ul className="pp-list">
            <li>Our biggest AI allowance</li>
            <li>Free mystery box with your first month</li>
            <li>Allowance grows as you shop</li>
            <li>Find, compare and fill your cart from chat</li>
          </ul>
          <Link href="/boxes" className="pp-btn pp-btn-main">
            Get Full + free box
          </Link>
        </div>
        {offer.lite.enabled && (
          <div className="pp-card">
            <div className="pp-name">Lite</div>
            <div className="pp-price">
              <strong>{money(offer.lite.priceCents)}</strong>
              <span>/month</span>
            </div>
            <div className="pp-sub">Keep the assistant, skip the box</div>
            <ul className="pp-list">
              <li>The AI sourcing assistant</li>
              <li>Find, compare and fill your cart from chat</li>
              <li>Upgrade any time</li>
            </ul>
            <form action={subscribeLite}>
              <input type="hidden" name="next" value={next} />
              <LiteButton />
            </form>
          </div>
        )}
      </div>
      <p className="pp-trust">
        <span>Cancel any time</span>
        <span aria-hidden>·</span>
        <span>Secure checkout by Stripe</span>
        <span aria-hidden>·</span>
        <span>Sign in with just your email</span>
      </p>
    </div>
  );
}
