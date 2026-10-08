"use client";

// "Who's coming?" → today's price for the same flights for that group, and Book. Searches run from the
// browser (never on page render), once on arrival and again when the group changes.

import { useCallback, useEffect, useState } from "react";
import { FlightCard } from "@/components/chat/ui";
import type { FlightCard as Card } from "@/lib/flights-shared";

type Result = { exact: Card[]; similar: Card[] } | { error: string };

export default function JoinTrip({ slug }: { slug: string }) {
  const [adults, setAdults] = useState(1);
  const [kids, setKids] = useState<number[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ adults: String(adults), children: kids.join(",") });
      const r = await fetch(`/api/trips/${encodeURIComponent(slug)}/offers?${q}`);
      setResult((await r.json()) as Result);
    } catch {
      setResult({ error: "Couldn't reach the airlines just now. Try again in a minute." });
    } finally {
      setLoading(false);
    }
  }, [slug, adults, kids]);

  // First search on arrival with one adult; later ones when the shopper taps the button.
  useEffect(() => void search(), []);

  const travellers = adults + kids.length;
  const book = (c: Card) => `/flights/book/${encodeURIComponent(c.id)}?trip=${encodeURIComponent(slug)}`;

  return (
    <section className="trip-join" aria-label="Join this trip">
      <h2 className="section-title">Who’s coming with you?</h2>
      <div className="trip-pax">
        <label>
          Adults
          <select value={adults} onChange={(e) => setAdults(Number(e.target.value))}>
            {Array.from({ length: 9 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
        {kids.map((age, i) => (
          <label key={i}>
            Child {i + 1} age
            <select value={age} onChange={(e) => setKids(kids.map((a, j) => (j === i ? Number(e.target.value) : a)))}>
              {Array.from({ length: 18 }, (_, a) => (
                <option key={a} value={a}>
                  {a === 0 ? "Under 1" : a}
                </option>
              ))}
            </select>
            <button type="button" className="trip-x" onClick={() => setKids(kids.filter((_, j) => j !== i))} aria-label={`Remove child ${i + 1}`}>
              ×
            </button>
          </label>
        ))}
        {kids.length < 8 && (
          <button type="button" className="btn" onClick={() => setKids([...kids, 8])}>
            + Child
          </button>
        )}
        <button type="button" className="btn primary" onClick={search} disabled={loading}>
          {loading ? "Checking seats…" : "Check today’s price"}
        </button>
      </div>

      {loading && !result && <p className="muted">Checking seats on these flights…</p>}
      {result && "error" in result && <p className="notice err">{result.error}</p>}
      {result && "exact" in result && (
        <div className="trip-results" aria-live="polite">
          {result.exact.length > 0 ? (
            <>
              <p className="trip-ok">
                ✓ Seats available on the same flights, for {travellers} traveller{travellers > 1 ? "s" : ""}:
              </p>
              {result.exact.map((c) => (
                <FlightCard key={c.id} f={c} bookHref={book(c)} />
              ))}
            </>
          ) : result.similar.length > 0 ? (
            <>
              <p className="trip-warn">These exact flights aren’t for sale right now. The closest flights that day:</p>
              {result.similar.map((c) => (
                <FlightCard key={c.id} f={c} bookHref={book(c)} />
              ))}
            </>
          ) : (
            <p className="notice">No seats on this route that day for {travellers} right now. Try fewer travellers, or ask the assistant for other dates.</p>
          )}
          <p className="muted small">Prices include taxes and our fee, for your whole group. The price is checked again before you pay.</p>
        </div>
      )}
    </section>
  );
}
