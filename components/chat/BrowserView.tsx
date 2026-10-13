"use client";
// The live browser in the chat: the screen of the Chrome Neon is driving, streamed as JPEG frames over a
// WebSocket. Tap "Take over" to drive it yourself (tap on the screen, type, scroll, go back), for a captcha,
// signing in or checking out; "Hand back" returns it to Neon. It only connects while it's on screen.

import { useEffect, useRef, useState } from "react";
import type { BrowserCard } from "@/lib/flights-shared";

type Status = "connecting" | "live" | "ended";

export default function BrowserView({ b }: { b: BrowserCard }) {
  const wrap = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<Status>("connecting");
  const [ended, setEnded] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [control, setControl] = useState(false);
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
    if (!visible || ended) return;
    let last: string | null = null;
    const sock = new WebSocket(b.live);
    sock.binaryType = "blob";
    ws.current = sock;
    sock.onopen = () => setStatus("live");
    sock.onmessage = (e) => {
      if (typeof e.data === "string") {
        try {
          const m = JSON.parse(e.data);
          if (m.t === "status") {
            setUrl(m.url || "");
            setControl(!!m.control);
          } else if (m.t === "ended") setEnded(m.reason || "This browser has closed.");
        } catch {}
        return;
      }
      const next = URL.createObjectURL(e.data as Blob);
      if (img.current) img.current.src = next;
      if (last) URL.revokeObjectURL(last);
      last = next;
      setFrame(true);
    };
    sock.onclose = () => {
      setStatus((s) => (s === "live" ? "ended" : s));
      ws.current = null;
    };
    sock.onerror = () => setEnded((e) => e ?? "This browser has closed.");
    return () => {
      sock.close();
      if (last) URL.revokeObjectURL(last);
    };
  }, [visible, ended, b.live]);

  const sendMsg = (m: unknown) => ws.current?.readyState === 1 && ws.current.send(JSON.stringify(m));
  const take = (on: boolean) => {
    sendMsg({ t: "control", on });
    setControl(on);
  };
  const tap = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!control) return;
    const r = e.currentTarget.getBoundingClientRect();
    sendMsg({ t: "tap", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };
  let host = b.site;
  try {
    if (url) host = new URL(url).hostname.replace(/^www\./, "");
  } catch {}

  const closed = !!ended || status === "ended";
  return (
    <div ref={wrap} className={`cx-browser${control ? " is-control" : ""}${closed ? " is-ended" : ""}`}>
      <div className="cx-browser-bar">
        <span className={`cx-browser-dot${status === "live" && !closed ? " is-live" : ""}`} aria-hidden />
        <span className="cx-browser-host">{host}</span>
        {!closed && status === "live" && (
          <button type="button" className={`cx-browser-take${control ? " is-on" : ""}`} onClick={() => take(!control)}>
            {control ? "Hand back to Neon" : "Take over"}
          </button>
        )}
      </div>
      {b.handoff && !control && !closed && <div className="cx-browser-turn">Your turn: {b.handoff}</div>}
      <div className="cx-browser-screen">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={img} alt={`Live view of ${host}`} onClick={tap} draggable={false} style={{ visibility: frame ? "visible" : "hidden" }} />
        {!frame && <span className="cx-browser-wait">{closed ? ended || "This browser has closed." : "Opening the browser…"}</span>}
        {closed && frame && <span className="cx-browser-closed">{ended || "This browser has closed."}</span>}
      </div>
      {control && !closed && (
        <div className="cx-browser-keys">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text) sendMsg({ t: "type", text });
              setText("");
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type into the page"
              aria-label="Type into the page"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button type="submit">Type</button>
          </form>
          <div className="cx-browser-row">
            <button type="button" onClick={() => sendMsg({ t: "back" })}>‹ Back</button>
            <button type="button" onClick={() => sendMsg({ t: "scroll", dy: -500 })}>▲</button>
            <button type="button" onClick={() => sendMsg({ t: "scroll", dy: 500 })}>▼</button>
            <button type="button" onClick={() => sendMsg({ t: "key", key: "Backspace" })}>⌫</button>
            <button type="button" onClick={() => sendMsg({ t: "key", key: "Enter" })}>Enter</button>
          </div>
          <p className="cx-browser-note">You're driving. Tap the page to click. What you type goes straight to Amazon; Neon doesn't see or store it.</p>
        </div>
      )}
    </div>
  );
}
