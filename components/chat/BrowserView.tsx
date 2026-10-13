"use client";
// The live browser in the chat: the screen of the Chrome Neon is driving, streamed as JPEG frames over a
// WebSocket and painted on a canvas (newest frame wins; no React work per frame).
//
// Three separate things (docs/frontier-port/CONTRACTS.md §7):
// - connection: connecting / live / reconnecting / offline / ended (LiveConnection, with a fresh short-lived
//   token per try from GET /api/assistant/browser);
// - presentation: inline in the chat, expanded because the shopper chose to take over, or expanded because the
//   run is waiting on a step only they can do (required);
// - the run: the server owns the pending step. "Done — continue" asks the server to resume exactly that step,
//   and the card only goes back into the chat when the server accepts it. Taking over by choice is never approval.
// The same component (and socket) is used inline and full screen; full screen renders through a portal, so the
// chat underneath keeps its draft, its scroll position and everything else.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BrowserCard } from "@/lib/flights-shared";
import type { ResumeResult } from "@/lib/run-shared";
import { useRunContext } from "./run-context";
import { CLOSED_REASON, FrameRenderer, LiveConnection, pageSize, scrollDelta, toFramePoint, type ConnState, type Decoded, type Size, type SocketLike, phoneViewport, sameSize, typingEdits } from "./browser-frames";

type Mode = "inline" | "voluntary" | "required";
type Frame = Decoded & { src: CanvasImageSource; free: () => void };

/** Decodes a JPEG blob for the canvas: createImageBitmap where available, else an <img> (object URL revoked on free). */
async function decodeFrame(blob: Blob): Promise<Frame> {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(blob);
    return { width: bmp.width, height: bmp.height, src: bmp, free: () => bmp.close() };
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { width: img.naturalWidth, height: img.naturalHeight, src: img, free: () => URL.revokeObjectURL(url) };
}

const connText = (c: ConnState): string =>
  c.s === "connecting" || c.s === "idle"
    ? "Connecting…"
    : c.s === "reconnecting"
      ? `Reconnecting… (${c.attempt}/${c.of})`
      : c.s === "offline"
        ? "Connection lost. Tap to reconnect."
        : c.s === "ended"
          ? c.reason
          : "";

export default function BrowserView({ b }: { b: BrowserCard }) {
  const run = useRunContext();
  const slot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const takeBtn = useRef<HTMLButtonElement>(null);
  const conn = useRef<LiveConnection | null>(null);
  const renderer = useRef<FrameRenderer<Blob, Frame> | null>(null);
  const lastBlob = useRef<Blob | null>(null);
  const meta = useRef<Size | null>(null);
  const typed = useRef("");
  const n = useRef(0);
  const drag = useRef<{ y: number; acc: number; moved: boolean; raf: number | null } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inlineHeight = useRef(0);
  /** Steps this card already asked the server to resume (the stream may still show them for a moment). */
  const resumed = useRef(new Set<string>());
  const pendingRef = useRef(run.pending);
  pendingRef.current = run.pending;

  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<ConnState>({ s: "idle" });
  const [mode, setMode] = useState<Mode>("inline");
  const [hasFrame, setHasFrame] = useState(false);
  const [host, setHost] = useState(b.site);
  const [needs, setNeeds] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [doneBusy, setDoneBusy] = useState(false);
  const [doneError, setDoneError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);

  const releasedByServer = useRef(false);
  const sentSize = useRef<Size | null>(null);
  /** Pending steps the shopper chose "Back to chat" for (not approvals). */
  const minimized = useRef(new Set<string>());
  const modeRef = useRef<Mode>("inline");
  modeRef.current = mode;
  const expanded = mode !== "inline";
  const mine = run.pending?.browser?.cardId === b.id && !resumed.current.has(run.pending.id) ? run.pending : null;
  const ended = state.s === "ended";

  const flash = useCallback((t: string) => {
    setToast(t);
    window.setTimeout(() => setToast((x) => (x === t ? null : x)), 2600);
  }, []);
  const send = useCallback((m: Record<string, unknown>) => conn.current?.send({ ...m, n: ++n.current }) ?? false, []);

  // Connect only while the card is on screen (old cards further up stay quiet) or full screen.
  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // One renderer and one connection for the life of the card.
  useEffect(() => {
    const r = new FrameRenderer<Blob, Frame>({
      decode: decodeFrame,
      draw: (f) => {
        const c = canvas.current;
        if (!c) return;
        if (c.width !== f.width || c.height !== f.height) {
          c.width = f.width;
          c.height = f.height;
        }
        c.getContext("2d", { alpha: false })?.drawImage(f.src, 0, 0);
      },
      release: (f) => f.free(),
      schedule: (cb) => requestAnimationFrame(() => cb()),
      onFrame: (_size, first) => first && setHasFrame(true),
    });
    renderer.current = r;
    const c = new LiveConnection({
      getToken: async (signal) => {
        if (!b.session || !run.chatId) return { ok: false, gone: true };
        const res = await fetch(`/api/assistant/browser?chat=${encodeURIComponent(run.chatId)}&session=${encodeURIComponent(b.session)}`, { signal, cache: "no-store" });
        if (res.status === 404) return { ok: false, gone: true };
        if (!res.ok) return { ok: false, gone: false };
        const d = (await res.json()) as { url?: string };
        return d.url ? { ok: true, url: d.url } : { ok: false, gone: false };
      },
      open: (url) => new WebSocket(url) as unknown as SocketLike,
      onState: setState,
      onFrame: (data) => {
        if (!(data instanceof Blob)) return;
        lastBlob.current = data;
        r.push(data);
      },
      onOpen: () => {
        // Back after a drop while the shopper was driving: take control again.
        if (modeRef.current !== "inline") takeControl();
      },
      onMessage: (m) => {
        if (m.t === "status") {
          try {
            if (typeof m.url === "string" && m.url) setHost(new URL(m.url).hostname.replace(/^www\./, ""));
          } catch {}
          setNeeds(typeof m.needs === "string" ? m.needs : null);
        } else if (m.t === "frame-meta" && typeof m.w === "number" && typeof m.h === "number") meta.current = { w: m.w, h: m.h };
        else if (m.t === "focus") setEditing(!!m.editing);
        else if (m.t === "control" && m.on === false) {
          // The server gave control back to Neon (the step was resumed), or another screen took over.
          if (m.by === "server") releasedByServer.current = true;
          if (modeRef.current === "voluntary" || (modeRef.current === "required" && m.by === "server")) leave();
        } else if (m.t === "control" && m.on === true) releasedByServer.current = false;
        else if (m.t === "error") {
          if (m.code === "failed" || m.code === "busy") flash(typeof m.message === "string" ? m.message : "Couldn't do that. Try again.");
          // Input dropped because control ended is expected; only a screen still in a take-over takes control again.
          else if (m.code === "not_in_control" && modeRef.current !== "inline" && !releasedByServer.current) takeControl();
        }
      },
      isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    });
    conn.current = c;
    const retry = () => c.retryNow();
    const onVis = () => document.visibilityState === "visible" && retry();
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVis);
      c.dispose();
      r.dispose();
      conn.current = null;
      renderer.current = null;
    };
    // The card's session and chat don't change for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    conn.current?.setWanted((visible || expanded) && !!b.session && !!run.chatId);
  }, [visible, expanded, b.session, run.chatId]);

  // The canvas element is recreated when the card moves to or from full screen: paint the last frame at once.
  useLayoutEffect(() => {
    if (lastBlob.current) renderer.current?.push(lastBlob.current);
  }, [expanded]);

  /** Takes control with the phone's full-screen browser area as the page size (CONTRACTS.md §11). */
  function takeControl() {
    releasedByServer.current = false;
    const size = screenSize();
    sentSize.current = size;
    conn.current?.send({ t: "control", on: true, ...(size ?? {}) });
  }
  function screenSize(): Size | null {
    const el = document.querySelector<HTMLElement>(`[data-browser="${b.id}"] .cx-browser-screen`);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    return phoneViewport(el.getBoundingClientRect(), { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) });
  }
  function enter(next: Mode) {
    if (modeRef.current === "inline") {
      inlineHeight.current = slot.current?.offsetHeight ?? 0;
      returnFocus.current = (document.activeElement as HTMLElement | null) ?? null;
    }
    setMode(next);
    setDoneError(null);
    setNote(null);
    // Control (with the screen size) once the full-screen layout exists.
    requestAnimationFrame(() => requestAnimationFrame(takeControl));
  }
  function leave() {
    setMode("inline");
    setEditing(false);
    setText("");
    typed.current = "";
    setDoneBusy(false);
    setDoneError(null);
  }
  function handBack() {
    conn.current?.send({ t: "control", on: false });
    leave();
  }

  // The run is waiting on the shopper in this browser: open full screen (same card, same socket), unless they
  // chose "Back to chat" for this step (the chat's approval message and bar can open it again).
  useEffect(() => {
    if (mine && mode !== "required" && !minimized.current.has(mine.id)) enter("required");
    else if (!mine && mode === "required" && !doneBusy) {
      // The step went away without this card resuming it (expired, cancelled, the run ended): back to the chat,
      // and the browser back to Neon.
      handBack();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine?.id]);

  // "Open browser" from the chat's approval message.
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<{ cardId?: string }>).detail?.cardId;
      if (id !== b.id || !pendingRef.current) return;
      minimized.current.delete(pendingRef.current.id);
      enter("required");
    };
    window.addEventListener("cx:open-browser", open);
    return () => window.removeEventListener("cx:open-browser", open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Back to chat during a required take-over: not an approval; the step stays pending in the chat. */
  function minimize() {
    if (pendingRef.current) minimized.current.add(pendingRef.current.id);
    handBack();
  }

  async function done() {
    const step = pendingRef.current;
    if (!step || doneBusy) return;
    setDoneBusy(true);
    setDoneError(null);
    let r: ResumeResult;
    try {
      // The same action as the chat's "Approve & next" message: one request per step, shared state.
      r = await run.approve(step.id);
    } catch {
      r = { accepted: false, reason: "not_waiting", message: "Couldn't reach Neon. Try again.", current: null };
    }
    setDoneBusy(false);
    if (r.accepted && r.stepId === step.id) {
      resumed.current.add(step.id);
      // A newer step that arrived meanwhile keeps the browser open (a late answer never hides it).
      const now = pendingRef.current;
      if (now && now.id !== step.id && now.browser?.cardId === b.id) return;
      conn.current?.send({ t: "control", on: false });
      leave();
      return;
    }
    if (!r.accepted && r.reason === "stale_step") {
      // Neon moved on to another step; ctx.pending now shows it.
      resumed.current.add(step.id);
      setDoneError(r.current?.pending ? null : r.message);
      return;
    }
    if (!r.accepted && r.reason === "not_waiting" && !r.current) {
      setDoneError(r.message || "Couldn't reach Neon. Try again.");
      return;
    }
    resumed.current.add(step.id);
    conn.current?.send({ t: "control", on: false });
    leave();
    if (!r.accepted) setNote(r.message);
  }

  // While full screen, the remote page follows the phone's browser area (rotation, the keyboard): debounced.
  useEffect(() => {
    if (!expanded) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const changed = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const size = screenSize();
        if (!size || sameSize(size, sentSize.current)) return;
        sentSize.current = size;
        send({ t: "viewport", ...size });
      }, 200);
    };
    window.visualViewport?.addEventListener("resize", changed);
    window.addEventListener("orientationchange", changed);
    window.addEventListener("resize", changed);
    return () => {
      if (t) clearTimeout(t);
      window.visualViewport?.removeEventListener("resize", changed);
      window.removeEventListener("orientationchange", changed);
      window.removeEventListener("resize", changed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // Full screen: lock the page behind it, follow the on-screen keyboard, and manage focus.
  useEffect(() => {
    if (!expanded) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const v = window.visualViewport;
    const fit = () => v && setVv({ h: v.height, top: v.offsetTop });
    fit();
    v?.addEventListener("resize", fit);
    v?.addEventListener("scroll", fit);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modeRef.current === "voluntary") handBack();
    };
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    return () => {
      document.body.style.overflow = prev;
      v?.removeEventListener("resize", fit);
      v?.removeEventListener("scroll", fit);
      window.removeEventListener("keydown", onKey);
      setVv(null);
      // Back in the chat: focus goes where it was (never into a text field on a phone, which pops the keyboard).
      const back = returnFocus.current;
      const touch = window.matchMedia?.("(pointer: coarse)").matches;
      const target = back && document.contains(back) && !(touch && /^(INPUT|TEXTAREA)$/.test(back.tagName)) ? back : takeBtn.current;
      requestAnimationFrame(() => target?.focus({ preventScroll: true }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // ---- Input: tap = click, drag = scroll (in the page's own pixels), typing mirrored into the focused field ----
  const box = () => {
    const c = canvas.current;
    if (!c || !c.width) return null;
    const r = c.getBoundingClientRect();
    return { rect: { left: r.left, top: r.top, width: r.width, height: r.height }, frame: { w: c.width, h: c.height } };
  };
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!expanded) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, acc: 0, moved: false, raf: null };
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < 8) return;
    d.moved = true;
    d.acc += d.y - e.clientY;
    d.y = e.clientY;
    if (d.raf == null)
      d.raf = requestAnimationFrame(() => {
        d.raf = null;
        const g = box();
        if (!g) return;
        const dy = Math.round(scrollDelta(d.acc, g.rect, g.frame, pageSize(meta.current, g.frame)));
        d.acc = 0;
        if (dy) send({ t: "scroll", dy });
      });
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d || !expanded) return;
    if (d.moved) {
      if (d.raf != null) cancelAnimationFrame(d.raf);
      const g = box();
      const dy = g ? Math.round(scrollDelta(d.acc, g.rect, g.frame, pageSize(meta.current, g.frame))) : 0;
      if (dy) send({ t: "scroll", dy });
      return;
    }
    const g = box();
    const p = g && toFramePoint(e.clientX, e.clientY, g.rect, g.frame);
    if (p) send({ t: "tap", x: p.x, y: p.y });
  }
  function onType(value: string) {
    for (const edit of typingEdits(typed.current, value)) send(edit);
    typed.current = value;
    setText(value);
  }

  const status = connText(state);
  const ask = !ended && !expanded && !mine ? needs || b.handoff || null : null;
  const message = mine?.message ?? null;
  const approval = mine ? run.approvals[mine.id] : undefined;
  const approveLabel = doneBusy || approval?.phase === "approving" ? "Approving…" : approval?.phase === "approved" ? "Approved" : approval?.phase === "error" ? "Try again" : "Approve & next";
  const fullStyle = expanded && vv ? { height: `${vv.h}px`, top: `${vv.top}px` } : undefined;

  const card = (
    <div
      className={`cx-browser${expanded ? " is-control is-full" : ""}${mode === "required" ? " is-required" : ""}${ended ? " is-ended" : ""}${ask ? " is-asking" : ""}`}
      data-browser={b.id}
      style={fullStyle}
      {...(expanded ? { role: "dialog", "aria-modal": true, "aria-labelledby": `${b.id}-title` } : {})}
    >
      <div className="cx-browser-bar">
        <span className={`cx-browser-dot${state.s === "live" ? " is-live" : ""}`} aria-hidden />
        <span className="cx-browser-host">{host}</span>
        {!ended && mode !== "required" && (
          <button type="button" ref={takeBtn} className={`cx-browser-take${expanded ? " is-on" : ""}`} onClick={() => (expanded ? handBack() : enter("voluntary"))}>
            {expanded ? "Hand back to Neon" : mine ? "Open" : "Take over"}
          </button>
        )}
        {!ended && mode === "required" && (
          <button type="button" className="cx-browser-take cx-browser-min" onClick={minimize}>
            Back to chat
          </button>
        )}
        {ended && expanded && (
          <button type="button" className="cx-browser-take" onClick={leave}>
            Close
          </button>
        )}
      </div>
      {expanded && (
        <div className={`cx-browser-turn${mode === "required" ? " cx-browser-required" : " is-driving"}`}>
          <p id={`${b.id}-title`} ref={heading} tabIndex={-1}>
            {mode === "required" ? message || "Neon needs you to finish this step." : "You're driving. Neon waits until you hand back."}
          </p>
        </div>
      )}
      <div className="cx-browser-screen">
        <canvas
          ref={canvas}
          className="cx-browser-canvas"
          role="img"
          aria-label={`Live view of ${host}. This is a remote screen; its contents can't be read by screen readers.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
          style={{ visibility: hasFrame ? "visible" : "hidden" }}
        />
        {(!hasFrame || state.s !== "live") && status && (
          <button type="button" className="cx-browser-conn" onClick={() => conn.current?.retryNow()} disabled={state.s !== "offline"}>
            {ended ? state.reason || CLOSED_REASON : status}
          </button>
        )}
        {toast && <span className="cx-browser-toast">{toast}</span>}
        {ask && state.s === "live" && (
          <div className="cx-browser-ask" role="alert">
            <p>{ask}</p>
            <button type="button" onClick={() => enter("voluntary")}>
              Take over
            </button>
          </div>
        )}
      </div>
      {expanded && !ended && (
        <div className="cx-browser-keys">
          <form
            className="cx-browser-typing"
            onSubmit={(e) => {
              e.preventDefault();
              send({ t: "key", key: "Enter" });
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
            <button type="button" onClick={() => send({ t: "back" })} aria-label="Back">
              ‹
            </button>
            <button type="button" onClick={() => send({ t: "key", key: "Backspace" })} aria-label="Delete">
              ⌫
            </button>
            <button type="submit" aria-label="Enter">
              ↵
            </button>
          </form>
          {mode === "required" && (
            <>
              {(doneError || approval?.phase === "error") && (
                <p className="cx-browser-done-error" role="alert">
                  {doneError || (approval?.phase === "error" ? approval.message : "")}
                </p>
              )}
              <div className="cx-browser-actions">
                <button type="button" className="cx-browser-done" onClick={done} disabled={doneBusy || !mine || approval?.phase === "approving" || approval?.phase === "approved"} aria-busy={doneBusy}>
                  {approveLabel}
                </button>
                <button type="button" className="cx-browser-stop" onClick={() => void run.stop()}>
                  Stop Neon
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {mode === "required" ? `Neon needs you: ${message ?? ""}` : status}
      </span>
    </div>
  );
  // Full screen renders at the top of the page so nothing in the chat (scrolling lists) can clip it.
  return (
    <div ref={slot} className="cx-browser-slot">
      {expanded && typeof document !== "undefined" ? (
        <>
          <div className="cx-browser-placeholder" style={inlineHeight.current ? { height: inlineHeight.current } : undefined}>
            Browser open full screen
          </div>
          {createPortal(card, document.body)}
        </>
      ) : (
        card
      )}
      {note && !expanded && <p className="cx-browser-note-inline">{note}</p>}
    </div>
  );
}
