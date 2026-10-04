"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { addToCart, type CartActionState } from "../../actions";
import type { PublicVariant } from "@/lib/storefront";
import ShippingEstimate from "@/components/store/ShippingEstimate";
import { bulkPricingLabel } from "@/lib/volume";
import { useRouter } from "next/navigation";
import Personalizer from "@/components/store/Personalizer";
import type { DesignerConfig } from "@/lib/personalize-shared";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export default function VariantPicker({
  optionNames,
  variants,
  initial,
  onChange,
  shipTo,
  personalize,
  mockupSrc,
}: {
  personalize?: DesignerConfig | null;
  mockupSrc?: string | null;
  shipTo: { country: string; zip: string };
  optionNames: string[];
  variants: PublicVariant[];
  initial: PublicVariant | null;
  onChange?: (v: PublicVariant | null) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string>>(initial?.options ?? {});
  const [state, action, pending] = useActionState<CartActionState, FormData>(addToCart, null);
  const router = useRouter();

  const values = useMemo(
    () =>
      Object.fromEntries(
        optionNames.map((n) => [n, Array.from(new Set(variants.map((v) => v.options[n]).filter(Boolean)))]),
      ) as Record<string, string[]>,
    [optionNames, variants],
  );

  // A selection resolves to exactly one real variant (each maps server-side to one supplier VID).
  const match = variants.find((v) => optionNames.every((n) => v.options[n] === selected[n])) ?? null;

  // Show a value's picture on its button when every value of that option has one (e.g. colours).
  const swatches = useMemo(
    () =>
      Object.fromEntries(
        optionNames.map((n) => {
          const imgs = values[n].map((val) => variants.find((v) => v.options[n] === val && v.imageSrc)?.imageSrc ?? null);
          return [n, imgs.every(Boolean) && new Set(imgs).size > 1 ? Object.fromEntries(values[n].map((val, i) => [val, imgs[i]!])) : null];
        }),
      ) as Record<string, Record<string, string> | null>,
    [optionNames, values, variants],
  );

  function choose(next: Record<string, string>) {
    setSelected(next);
    onChange?.(variants.find((v) => optionNames.every((n) => v.options[n] === next[n])) ?? null);
  }

  function exists(name: string, value: string) {
    return variants.some((v) => v.options[name] === value && optionNames.every((n) => n === name || v.options[n] === selected[n]));
  }

  if (variants.length === 0) return <p className="stock stock-UNAVAILABLE">Currently unavailable</p>;

  return (
    <>
    <form action={action} className="picker">
      <div className="price">{match ? money(match.priceCents) : "—"}</div>
      <div className="vol-tiers small">{bulkPricingLabel()}</div>
      {match && optionNames.length === 0 && variants.length > 1 && <div className="muted small">{match.name}</div>}
      {optionNames
        .filter((name) => values[name].length > 1)
        .map((name) => (
        <fieldset key={name}>
          <legend>
            {name}
            {selected[name] && <span className="legend-value">: {selected[name]}</span>}
          </legend>
          <div className="options">
            {values[name].map((val) => (
              <button
                type="button"
                key={val}
                className={`opt ${swatches[name] ? "opt-swatch" : ""} ${selected[name] === val ? "on" : ""} ${exists(name, val) ? "" : "dim"}`}
                aria-pressed={selected[name] === val}
                title={val}
                onClick={() => {
                  const next = { ...selected, [name]: val };
                  const ok = variants.some((v) => optionNames.every((n) => v.options[n] === next[n]));
                  choose(ok ? next : variants.find((v) => v.options[name] === val)?.options ?? next);
                }}
              >
                {swatches[name] && <img src={swatches[name]![val]} alt="" loading="lazy" />}
                <span>{val}</span>
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <p className="availability">
        {match ? (
          <span className={`stock stock-${match.stock}`}>
            <span className="dot" aria-hidden /> {match.stockLabel}
          </span>
        ) : (
          <span className="muted">That combination isn’t available — choose another option</span>
        )}
      </p>
      <input type="hidden" name="variantId" value={match?.id ?? ""} />
      {personalize ? null : (
      <div className="buy-row">
        <input className="qty" type="number" name="quantity" min={1} max={99} defaultValue={1} aria-label="Quantity" />
        <button className="btn primary lg grow-btn" disabled={!match || match.stock === "UNAVAILABLE" || pending}>
          {pending ? "Checking stock…" : "Add to cart"}
        </button>
      </div>
      )}
      {state && (
        <p className={state.ok ? "notice ok" : "notice err"}>
          {state.message} {state.ok && <Link href="/cart">View cart →</Link>}
        </p>
      )}
    </form>
    {personalize && (
      <Personalizer
        config={personalize}
        imageSrc={mockupSrc ?? null}
        variantId={match?.id ?? null}
        disabled={!match || match.stock === "UNAVAILABLE"}
        onAdded={(r) => r.ok && router.refresh()}
      />
    )}
    <ShippingEstimate key={match?.id ?? "none"} variantId={match?.id ?? null} country={shipTo.country} zip={shipTo.zip} />
    </>
  );
}
