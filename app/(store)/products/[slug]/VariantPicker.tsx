"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { addToCart, type CartActionState } from "../../actions";
import type { PublicVariant } from "@/lib/storefront";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export default function VariantPicker({ optionNames, variants }: { optionNames: string[]; variants: PublicVariant[] }) {
  const firstBuyable = variants.find((v) => v.stock !== "UNAVAILABLE") ?? variants[0];
  const [selected, setSelected] = useState<Record<string, string>>(firstBuyable?.options ?? {});
  const [state, action, pending] = useActionState<CartActionState, FormData>(addToCart, null);

  const values = useMemo(
    () =>
      Object.fromEntries(
        optionNames.map((n) => [n, Array.from(new Set(variants.map((v) => v.options[n]).filter(Boolean)))]),
      ) as Record<string, string[]>,
    [optionNames, variants],
  );

  // A selection resolves to exactly one real variant (each maps server-side to one supplier VID).
  const match = variants.find((v) => optionNames.every((n) => v.options[n] === selected[n])) ?? null;

  function exists(name: string, value: string) {
    return variants.some((v) => v.options[name] === value && optionNames.every((n) => n === name || v.options[n] === selected[n]));
  }

  if (variants.length === 0) return <p className="stock stock-UNAVAILABLE">Currently unavailable</p>;

  return (
    <form action={action} className="picker">
      <div className="price">{match ? money(match.priceCents) : "—"}</div>
      {optionNames.map((name) => (
        <fieldset key={name}>
          <legend>{name}</legend>
          <div className="options">
            {values[name].map((val) => (
              <button
                type="button"
                key={val}
                className={`opt ${selected[name] === val ? "on" : ""} ${exists(name, val) ? "" : "dim"}`}
                onClick={() => {
                  const next = { ...selected, [name]: val };
                  const ok = variants.some((v) => optionNames.every((n) => v.options[n] === next[n]));
                  setSelected(ok ? next : variants.find((v) => v.options[name] === val)?.options ?? next);
                }}
              >
                {val}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <p>
        <strong>Availability:</strong>{" "}
        {match ? <span className={`stock stock-${match.stock}`}>{match.stockLabel}</span> : "Choose an option"}
      </p>
      <input type="hidden" name="variantId" value={match?.id ?? ""} />
      <div className="row gap">
        <input className="qty" type="number" name="quantity" min={1} max={99} defaultValue={1} aria-label="Quantity" />
        <button className="btn primary" disabled={!match || match.stock === "UNAVAILABLE" || pending}>
          {pending ? "Checking stock…" : "Add to cart"}
        </button>
      </div>
      {state && (
        <p className={state.ok ? "notice ok" : "notice err"}>
          {state.message} {state.ok && <Link href="/cart">View cart →</Link>}
        </p>
      )}
    </form>
  );
}
