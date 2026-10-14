"use client";

import { useState } from "react";

/** The Allow button sits outside its form (so Allow and Cancel share one row); it shows progress once tapped. */
export function AllowButton({ form, label }: { form: string; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="cn-btn primary" form={form} onClick={() => {
        setBusy(true);
        // The one moment on the page: the link between Chit and the app fills with light.
        document.getElementById("cn-pair")?.classList.add("linking");
      }} aria-busy={busy}>
      {busy ? <span className="cn-spin" aria-hidden /> : null}
      {busy ? "Connecting…" : label}
    </button>
  );
}
