"use client";

// The Trips menu in the chat: every trip the shopper booked in their chats, each with its itinerary and its
// receipts and confirmations (bookings, the Amazon cart, emails Neon sent). Data: GET /api/trips (lib/trips.ts).

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ItineraryItem, Trip, TripReceipt } from "@/lib/trips";

const ICON: Record<ItineraryItem["kind"] | TripReceipt["kind"], string> = {
  flight: "✈️",
  checkin: "🏨",
  checkout: "🧳",
  "car-pickup": "🚗",
  "car-dropoff": "🚗",
  car: "🚗",
  package: "📦",
  email: "✉️",
  hotel: "🏨",
  amazon: "📦",
};

function when(w: string | null): string {
  if (!w) return "";
  const d = new Date(`${w.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return w.length > 10 ? `${d} · ${w.slice(11, 16)}` : d;
}
const paidOn = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

export default function TripsPanel({ onClose }: { onClose: () => void }) {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<"itinerary" | "receipts">("itinerary");

  useEffect(() => {
    let live = true;
    fetch("/api/trips", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { trips: Trip[] }) => live && setTrips(d.trips))
      .catch(() => live && setFailed(true));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      live = false;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const trip = trips?.find((t) => t.chatId === openId) ?? null;

  return (
    <div className="tp-scrim" role="dialog" aria-modal="true" aria-label="Trips" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tp">
        <div className="tp-head">
          {trip ? (
            <button type="button" className="tp-back" onClick={() => setOpenId(null)} aria-label="All trips">
              ‹ Trips
            </button>
          ) : (
            <span className="tp-title">Trips</span>
          )}
          <button type="button" className="tp-close" onClick={onClose} aria-label="Close trips">
            ✕
          </button>
        </div>

        {!trip && (
          <div className="tp-body">
            {failed && <p className="tp-empty">Couldn&apos;t load your trips. Try again in a moment.</p>}
            {!failed && !trips && <p className="tp-empty">Loading your trips…</p>}
            {trips && trips.length === 0 && (
              <p className="tp-empty">
                No trips yet. Ask Neon to book a flight or a hotel, and once you&apos;ve paid, the trip shows up here with its itinerary and receipts.
              </p>
            )}
            {trips?.map((t) => (
              <button
                key={t.chatId}
                type="button"
                className={`tp-trip is-${t.cancelled ? "cancelled" : t.phase}`}
                onClick={() => {
                  setOpenId(t.chatId);
                  setTab("itinerary");
                }}
              >
                <span className="tp-trip-title">{t.title}</span>
                <span className="tp-trip-sub">
                  {t.cancelled ? "Cancelled" : t.phase === "now" ? "Happening now" : t.phase === "past" ? "Past trip" : "Upcoming"} · {t.receipts.filter((r) => r.kind === "flight" || r.kind === "hotel").length} booking
                  {t.receipts.filter((r) => r.kind === "flight" || r.kind === "hotel").length === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>
        )}

        {trip && (
          <div className="tp-body">
            <h2 className="tp-h">{trip.title}</h2>
            <Link href={`/c/${encodeURIComponent(trip.chatId)}`} className="tp-chat" onClick={onClose}>
              Open the chat: {trip.chatTitle}
            </Link>
            <div className="tp-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "itinerary"} className={tab === "itinerary" ? "is-on" : ""} onClick={() => setTab("itinerary")}>
                Itinerary
              </button>
              <button type="button" role="tab" aria-selected={tab === "receipts"} className={tab === "receipts" ? "is-on" : ""} onClick={() => setTab("receipts")}>
                Receipts &amp; confirmations
              </button>
            </div>

            {tab === "itinerary" && (
              <ol className="tp-itin">
                {trip.itinerary.length === 0 && <li className="tp-empty">Nothing scheduled.</li>}
                {trip.itinerary.map((i, n) => (
                  <li key={n} className={`tp-item is-${i.kind}`}>
                    <span className="tp-icon" aria-hidden>
                      {ICON[i.kind]}
                    </span>
                    <div>
                      {i.when && <div className="tp-when">{when(i.when)}</div>}
                      <div className="tp-item-title">{i.title}</div>
                      <div className="tp-item-detail">{i.detail}</div>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            {tab === "receipts" && (
              <div className="tp-receipts">
                {trip.receipts.map((r, n) => (
                  <div key={n} className="tp-receipt">
                    <div className="tp-receipt-top">
                      <span className="tp-icon" aria-hidden>
                        {ICON[r.kind]}
                      </span>
                      <span className="tp-receipt-title">{r.title}</span>
                      <span className={`tp-status is-${r.status.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{r.status}</span>
                    </div>
                    <dl className="tp-facts">
                      {r.confirmation && (
                        <>
                          <dt>Confirmation</dt>
                          <dd className="tp-code">{r.confirmation}</dd>
                        </>
                      )}
                      {r.number && (
                        <>
                          <dt>Booking</dt>
                          <dd>{r.number}</dd>
                        </>
                      )}
                      {r.amount && (
                        <>
                          <dt>Paid</dt>
                          <dd>
                            {r.amount}
                            {r.at ? ` · ${paidOn(r.at)}` : ""}
                          </dd>
                        </>
                      )}
                      {r.refunded && (
                        <>
                          <dt>Refunded</dt>
                          <dd>{r.refunded}</dd>
                        </>
                      )}
                    </dl>
                    {r.lines?.map((l, k) => (
                      <p key={k} className="tp-line">
                        {l}
                      </p>
                    ))}
                    {r.href && (
                      <a className="tp-link" href={r.href} target={r.kind === "amazon" || r.kind === "car" ? "_blank" : undefined} rel={r.kind === "amazon" || r.kind === "car" ? "noopener noreferrer" : undefined}>
                        {r.kind === "amazon" ? "Check out on Amazon" : r.kind === "car" ? "Find a car on Discover Cars" : "View booking & receipt"}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
