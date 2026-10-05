"use client";

import { useEffect, useState } from "react";

/** A date shown in the shopper's own time zone (the server only knows UTC). */
export default function LocalTime({ iso, withTime = true }: { iso: string; withTime?: boolean }) {
  const fmt = (tz?: string) =>
    new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}), timeZone: tz });
  const [text, setText] = useState(() => fmt("UTC"));
  useEffect(() => setText(fmt()), [iso]); // eslint-disable-line react-hooks/exhaustive-deps
  return <time dateTime={iso}>{text}</time>;
}
