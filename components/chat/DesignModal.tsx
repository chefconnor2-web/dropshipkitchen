"use client";

// The print-on-demand designer inside the chat: pick an option, design it (photos the shopper already sent
// are one tap away), and add it to the cart without leaving the conversation.

import { useEffect, useState } from "react";
import Personalizer, { type AddResult } from "@/components/store/Personalizer";
import type { ChatDesigner } from "@/lib/personalize";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export default function DesignModal({ designer, photos, onClose, onAdded }: { designer: ChatDesigner; photos: string[]; onClose: () => void; onAdded: (r: AddResult) => void }) {
  const [optionId, setOptionId] = useState(designer.options.find((o) => o.available)?.id ?? designer.options[0]?.id ?? "");
  const option = designer.options.find((o) => o.id === optionId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="pz-modal" role="dialog" aria-modal="true" aria-label={`Personalize ${designer.title}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pz-modal-card">
        <div className="pz-modal-head">
          <div>
            <div className="pz-modal-title">{designer.title}</div>
            {option && <div className="pz-modal-price">{money(option.priceCents)}</div>}
          </div>
          <button type="button" className="pz-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {designer.options.length > 1 && (
          <label className="pz-option">
            Option
            <select value={optionId} onChange={(e) => setOptionId(e.target.value)}>
              {designer.options.map((o) => (
                <option key={o.id} value={o.id} disabled={!o.available}>
                  {o.name} · {money(o.priceCents)}
                  {o.available ? "" : " (sold out)"}
                </option>
              ))}
            </select>
          </label>
        )}
        <Personalizer
          config={designer.config}
          imageSrc={option?.imageSrc ?? designer.imageSrc}
          variantId={option?.id ?? null}
          disabled={!option?.available}
          photos={photos}
          onAdded={onAdded}
        />
      </div>
    </div>
  );
}
