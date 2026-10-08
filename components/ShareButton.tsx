"use client";

// "Share" button: opens a panel of social networks (WhatsApp, Facebook, X, Threads, Pinterest…), the phone's
// own share sheet for the apps with no web share page (Instagram, TikTok, Snapchat), and Copy link. Links
// may be relative ("/products/x"); they're made absolute against the page's own address when the panel opens.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { shareTargets, taggedUrl, type ShareNetwork } from "@/lib/share";

const GLYPH: Record<ShareNetwork, string> = {
  whatsapp: "W",
  facebook: "f",
  messenger: "m",
  x: "𝕏",
  threads: "@",
  bluesky: "🦋",
  linkedin: "in",
  reddit: "r",
  pinterest: "P",
  telegram: "✈",
  sms: "💬",
  email: "✉",
};

function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="M7.5 7.5 12 3l4.5 4.5" />
      <path d="M5 12v6a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-6" />
    </svg>
  );
}

export default function ShareButton({
  url,
  resolve,
  text,
  image,
  label = "Share",
  className = "",
  modal = false,
}: {
  /** What to share; relative paths are resolved against the current site. */
  url?: string;
  /** Makes the link on first open instead (e.g. a trip link for a chat flight card); throws a message to show. */
  resolve?: () => Promise<string>;
  /** The line that goes with the link ("Look what I found on Chit: …"). */
  text: string;
  /** A picture for Pinterest. */
  image?: string | null;
  label?: string;
  className?: string;
  /** Open as a centred pop-up over the page (for buttons inside scrolling rows that would clip a dropdown). */
  modal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [env, setEnv] = useState<{ abs: string; img: string | null; native: boolean; phone: boolean } | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const link = url ?? made;

  useEffect(() => {
    if (!open || link || !resolve) return;
    setProblem(null);
    resolve().then(setMade, (e: unknown) => setProblem(e instanceof Error ? e.message : "Couldn't make a link. Try again."));
  }, [open, link, resolve]);

  useEffect(() => {
    if (!open) return;
    const abs = (u: string) => new URL(u, window.location.href).toString();
    if (link)
      setEnv({
        abs: abs(link),
        img: image ? abs(image) : null,
        native: typeof navigator.share === "function",
        phone: window.matchMedia("(pointer: coarse)").matches,
      });
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, link, image]);

  async function nativeShare() {
    if (!env) return;
    try {
      await navigator.share({ title: text, text, url: taggedUrl(env.abs, "native") });
      setOpen(false);
    } catch {
      // Dismissed, or the browser refused: the panel stays open.
    }
  }

  async function copy() {
    if (!env) return;
    try {
      await navigator.clipboard.writeText(taggedUrl(env.abs, "copy"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this link:", env.abs);
    }
  }

  // A pop-up goes on the page body, with a dimmed backdrop, so no parent can clip it.
  const place = (content: ReactNode) => (!open ? null : modal ? createPortal(<div className="share-modal">{content}</div>, document.body) : content);

  const targets = env ? shareTargets(env.abs, text, env.img).filter((t) => env.phone || !t.mobileOnly) : [];

  return (
    <div className={`share ${className}`} ref={root}>
      <button type="button" className="share-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ShareIcon />
        {label}
      </button>
      {place(
        <>
          {open && !env && (
            <div className={`share-panel${modal ? " share-panel-modal" : ""}`} role="dialog" aria-label="Share" ref={panel}>
              <p className={problem ? "notice err" : "muted"}>{problem ?? "Making your link…"}</p>
            </div>
          )}
          {open && env && (
            <div className={`share-panel${modal ? " share-panel-modal" : ""}`} role="dialog" aria-label="Share" ref={panel}>
              <div className="share-head">
                <span>Share</span>
                <button type="button" className="share-x" onClick={() => setOpen(false)} aria-label="Close">
                  ×
                </button>
              </div>
              {env.native && (
                <button type="button" className="share-native" onClick={nativeShare}>
                  <span className="share-native-dots" aria-hidden>
                    •••
                  </span>
                  <span>
                    <strong>Instagram, TikTok, Snapchat & more</strong>
                    <small>Opens your phone’s share menu</small>
                  </span>
                </button>
              )}
              <ul className="share-grid">
                {targets.map((t) => {
                  const web = t.href.startsWith("https:");
                  return (
                    <li key={t.id}>
                      <a href={t.href} target={web ? "_blank" : undefined} rel={web ? "noopener noreferrer" : undefined} onClick={() => setOpen(false)}>
                        <span className="share-chip" style={{ background: t.color }} aria-hidden>
                          {GLYPH[t.id]}
                        </span>
                        {t.label}
                      </a>
                    </li>
                  );
                })}
              </ul>
              {!env.native && <p className="share-note">Instagram, TikTok or Snapchat: copy the link and paste it into your story, bio or a message.</p>}
              <button type="button" className="share-copy" onClick={copy}>
                {copied ? "Link copied ✓" : "Copy link"}
              </button>
            </div>
          )}
        </>,
      )}
    </div>
  );
}
