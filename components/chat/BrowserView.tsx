"use client";
// The live browser in the chat: the screen of the Chrome Neon is driving, streamed as JPEG frames over a
// WebSocket. When a page needs the shopper (a robot check, signing in, checking out) a Take over prompt covers
// the screen. Taking over opens it full screen on Amazon's phone site, sized for the shopper's phone: tap to
// click, swipe to scroll, and type in the box at the bottom (each key goes straight to the field they tapped).
// "Hand back to Neon" returns it to the card. It only connects while it's on screen (or full screen).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BrowserCard } from "@/lib/flights-shared";

type Status = "connecting" | "live" | "ended";

export default function BrowserView({ b }: { b: BrowserCard }) {
  const wrap = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const typed = useRef(""); // what's in the typing box, to send only the change
  const drag = useRef<{ y: number; last: number; moved: boolean; pending: number; timer: number | null } | null>(null);
  // The latest frame, so the screen isn't blank after moving to or from full screen.
  const lastFrame = useRef<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<Status>("connecting");
  const [ended, setEnded] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [control, setControl] = useState(false);
  const [needs, setNeeds] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [frame, setFrame] = useState(false);

  // Connect only while the card is on screen (old cards further up stay quiet).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if ((!visible && !control) || ended) return;
    const sock = new WebSocket(b.live);
    sock.binaryType = "blob";
    ws.current = sock;
    sock.onopen = () => {
      setStatus("live");
      if (control) sock.send(JSON.stringify({ t: "control", on: true }));
    };
    sock.onmessage = (e) => {
      if (typeof e.data === "string") {
        try {
          const m = JSON.parse(e.data);
          if (m.t === "status") {
            setUrl(m.url || "");
            setNeeds(m.needs || null);
          } else if (m.t === "focus") setEditing(!!m.editing);
          else if (m.t === "ended") setEnded(m.reason || "This browser has closed.");
        } catch {}
        return;
      }
      const next = URL.createObjectURL(e.data as Blob);
      if (img.current) img.current.src = next;
      if (lastFrame.current) URL.revokeObjectURL(lastFrame.current);
      lastFrame.current = next;
      setFrame(true);
    };
    sock.onclose = () => {
      setStatus((s) => (s === "live" ? "ended" : s));
      ws.current = null;
    };
    sock.onerror = () => setEnded((e) => e ?? "This browser has closed.");
    return () => sock.close();
    // `control` is read only when (re)connecting; toggling it sends a message instead of reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ended, b.live]);

  // The image element is recreated when the card moves to or from full screen: show the last frame at once.
  useEffect(() => {
    if (img.current && lastFrame.current) img.current.src = lastFrame.current;
  }, [control]);
  useEffect(() => () => void (lastFrame.current && URL.revokeObjectURL(lastFrame.current)), []);

  // Full screen while the shopper drives: no page scrolling behind it.
  useEffect(() => {
    if (!control) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && take(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control]);

  const sendMsg = (m: unknown) => ws.current?.readyState === 1 && ws.current.send(JSON.stringify(m));
  function take(on: boolean) {
    sendMsg({ t: "control", on });
    setControl(on);
    setEditing(false);
    setText("");
    typed.current = "";
  }

  // Tap = click; drag = scroll the page (in the page's own pixels).
  function onPointerDown(e: React.PointerEvent<HTMLImageElement>) {
    if (!control) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, last: e.clientY, moved: false, pending: 0, timer: null };
  }
  function onPointerMove(e: React.PointerEvent<HTMLImageElement>) {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < 8) return;
    d.moved = true;
    const r = e.currentTarget.getBoundingClientRect();
    // Frames come at the page's own size (or twice it on high-density captures).
    const nat = e.currentTarget.naturalHeight || r.height;
    const pagePerPx = (nat > 1000 ? nat / 2 : nat) / r.height;
    d.pending += (d.last - e.clientY) * pagePerPx;
    d.last = e.clientY;
    if (d.timer == null)
      d.timer = window.setTimeout(() => {
        if (drag.current === d || drag.current === null) {
          sendMsg({ t: "scroll", dy: Math.round(d.pending) });
          d.pending = 0;
        }
        d.timer = null;
      }, 60);
  }
  function onPointerUp(e: React.PointerEvent<HTMLImageElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d || !control) return;
    if (d.moved) {
      if (d.timer == null && d.pending) sendMsg({ t: "scroll", dy: Math.round(d.pending) });
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    sendMsg({ t: "tap", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  }

  // Mirror the typing box into the page: added characters are typed, removed ones are backspaced.
  function onType(value: string) {
    const prev = typed.current;
    if (value.startsWith(prev)) {
      if (value.length > prev.length) sendMsg({ t: "type", text: value.slice(prev.length) });
    } else if (prev.startsWith(value)) {
      for (let i = 0; i < prev.length - value.length; i++) sendMsg({ t: "key", key: "Backspace" });
    } else {
      for (let i = 0; i < prev.length; i++) sendMsg({ t: "key", key: "Backspace" });
      if (value) sendMsg({ t: "type", text: value });
    }
    typed.current = value;
    setText(value);
  }

  let host = b.site;
  try {
    if (url) host = new URL(url).hostname.replace(/^www\./, "");
  } catch {}

  const closed = !!ended || status === "ended";
  // The page itself says it needs the shopper (robot check, sign in), or Neon asked them to take over.
  const ask = !closed && !control ? needs || b.handoff || null : null;
  const card = (
    <div className={`cx-browser${control ? " is-control is-full" : ""}${closed ? " is-ended" : ""}${ask ? " is-asking" : ""}`}>
      <div className="cx-browser-bar">
        <span className={`cx-browser-dot${status === "live" && !closed ? " is-live" : ""}`} aria-hidden />
        <span className="cx-browser-host">{host}</span>
        {!closed && status === "live" && (
          <button type="button" className={`cx-browser-take${control ? " is-on" : ""}`} onClick={() => take(!control)}>
            {control ? "Hand back to Neon" : "Take over"}
          </button>
        )}
      </div>
      <div className="cx-browser-screen">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={img}
          alt={`Live view of ${host}`}
          draggable={false}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
          style={{ visibility: frame ? "visible" : "hidden" }}
        />
        {!frame && <span className="cx-browser-wait">{closed ? ended || "This browser has closed." : "Opening the browser…"}</span>}
        {closed && frame && <span className="cx-browser-closed">{ended || "This browser has closed."}</span>}
        {ask && status === "live" && (
          <div className="cx-browser-ask" role="alert">
            <p>{ask}</p>
            <button type="button" onClick={() => take(true)}>
              Take over
            </button>
          </div>
        )}
      </div>
      {control && !closed && (
        <div className="cx-browser-keys">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMsg({ t: "key", key: "Enter" });
              typed.current = "";
              setText("");
            }}
          >
            <input
              className={editing ? "is-editing" : ""}
              value={text}
              onChange={(e) => onType(e.target.value)}
              placeholder={editing ? "Type here: it goes into the field you tapped" : "Tap a field on the page, then type here"}
              aria-label="Type into the page"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
            />
          </form>
          <div className="cx-browser-row">
            <button type="button" onClick={() => sendMsg({ t: "back" })}>‹ Back</button>
            <button type="button" onClick={() => sendMsg({ t: "key", key: "Backspace" })} aria-label="Delete">
              ⌫
            </button>
            <button type="button" onClick={() => sendMsg({ t: "key", key: "Enter" })}>Enter</button>
          </div>
        </div>
      )}
    </div>
  );
  // Full screen renders at the top of the page so nothing in the chat (scrolling lists) can clip it.
  return (
    <div ref={wrap} className="cx-browser-slot">
      {control && typeof document !== "undefined" ? (
        <>
          <div className="cx-browser-placeholder">Browser open full screen</div>
          {createPortal(card, document.body)}
        </>
      ) : (
        card
      )}
    </div>
  );
}
