"use client";

// After a booking from the chat is confirmed: back to that chat after a short countdown, where Neon carries on
// with the next step (the chat sends "I booked …" for the shopper, once). While it's still confirming, it says
// it'll go back once it's done.

import { useEffect, useState } from "react";

const SECONDS = 3;

export default function BackToChat({ chatId, booked, what, done, pending = !done }: { chatId: string; booked: string; what: string; done: boolean; pending?: boolean }) {
  const href = `/c/${encodeURIComponent(chatId)}?booked=${encodeURIComponent(booked)}`;
  const [left, setLeft] = useState(SECONDS);
  const [stay, setStay] = useState(false);
  useEffect(() => {
    if (!done || stay) return;
    if (left <= 0) {
      window.location.assign(href);
      return;
    }
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [done, stay, left, href]);
  if (!done && pending) return <p className="b2c-note">Once your {what} is confirmed, we&apos;ll take you back to the chat so Neon can carry on.</p>;
  // Not booked (failed, refunded, being checked): just the way back, no automatic message.
  if (!done)
    return (
      <div className="b2c">
        <a className="btn block" href={`/c/${encodeURIComponent(chatId)}`}>
          Back to the chat
        </a>
      </div>
    );
  return (
    <div className="b2c">
      <a className="btn primary block" href={href}>
        Back to the chat{stay ? "" : ` (${left})`}
      </a>
      {!stay && (
        <button type="button" className="b2c-stay" onClick={() => setStay(true)}>
          Stay on this page
        </button>
      )}
      <p className="b2c-note">Neon carries on with the next step of your trip.</p>
    </div>
  );
}
