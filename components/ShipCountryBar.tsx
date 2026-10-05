"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveDestination } from "@/app/(store)/actions";
import { refreshShipBadges } from "./ShipBadge";

/** "Shipping to: Canada ▾" above product grids; changing it rechecks every badge on the page. */
export default function ShipCountryBar({ country, countries }: { country: string; countries: Array<{ code: string; name: string }> }) {
  const router = useRouter();
  const [value, setValue] = useState(country);
  const [pending, start] = useTransition();
  return (
    <label className="ship-bar">
      <span>Shipping to</span>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          start(async () => {
            await saveDestination(next, "");
            refreshShipBadges();
            router.refresh();
          });
        }}
      >
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
