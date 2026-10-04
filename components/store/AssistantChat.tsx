"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface Card {
  pid: string;
  title: string;
  fromCents: number;
}
type Entry = { role: "user"; text: string } | { role: "assistant"; text: string; cards: Card[]; added: string[] };

const EXAMPLES = [
  "I need a battery setup for a custom 48V e-bike, plus the tools to do it myself",
  "Stock a small café: 200 compostable cups, lids and a milk frother",
  "Solar setup to run a fridge and lights in a cabin",
  "Everything to start screen-printing t-shirts at home",
];

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** Tiny, safe formatter for the assistant's replies: paragraphs, "- " bullets, **bold**. No HTML injection. */
function Formatted({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
    );
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split("\n").filter((l) => l.trim());
        if (lines.length && lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>
              ))}
            </ul>
          );
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {inline(l.replace(/^#+\s*/, ""))}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

export default function AssistantChat() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [configured, setConfigured] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cartCount, setCartCount] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/assistant")
      .then((r) => r.json())
      .then((d) => {
        setEntries(d.entries ?? []);
        setConfigured(d.configured !== false);
        setCartCount(d.cartCount ?? 0);
      })
      .catch(() => null);
  }, []);
  useEffect(() => {
    if (entries.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [entries, busy]);

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setEntries((e) => [...e, { role: "user", text: msg }]);
    try {
      const r = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg }) });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Something went wrong.");
      }
      // Read the NDJSON stream: progress notes, then the finished reply.
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "progress") setProgress(ev.note);
          else if (ev.type === "error") throw new Error(ev.error);
          else if (ev.type === "done") {
            setEntries((e) => [...e, ev.entry]);
            setCartCount(ev.cartCount ?? 0);
            done = true;
          }
        }
      }
      if (!done) throw new Error("The connection dropped. Please try again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setEntries((e) => e.slice(0, -1));
      setInput(msg);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function quickAdd(card: Card) {
    const r = await fetch("/api/assistant/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: card.pid }) });
    const d = await r.json().catch(() => ({}));
    if (d.chooseAt) {
      window.open(d.chooseAt, "_blank");
      return;
    }
    if (typeof d.cartCount === "number") setCartCount(d.cartCount);
    setToast(d.message ?? (d.ok ? "Added to cart" : "Couldn’t add that"));
    setTimeout(() => setToast(null), 3500);
  }

  async function reset() {
    await fetch("/api/assistant", { method: "DELETE" });
    setEntries([]);
    setError(null);
  }

  return (
    <div className="ai">
      <div className="ai-log" aria-live="polite">
        {entries.length === 0 && (
          <div className="ai-empty">
            <p className="ai-hello">Tell me what you’re building or need. I’ll put together the parts list, find each item, and fill your cart.</p>
            <div className="ai-examples">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" onClick={() => send(x)} disabled={busy || !configured}>
                  {x}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map((e, i) =>
          e.role === "user" ? (
            <div key={i} className="ai-msg ai-user">
              {e.text}
            </div>
          ) : (
            <div key={i} className="ai-msg ai-bot">
              <Formatted text={e.text} />
              {e.added.length > 0 && (
                <div className="ai-added">
                  {e.added.map((a) => (
                    <div key={a}>✓ Added {a}</div>
                  ))}
                  <Link href="/cart">Review cart →</Link>
                </div>
              )}
              {e.cards.length > 0 && (
                <div className="ai-cards">
                  {e.cards.map((c) => (
                    <div key={c.pid} className="ai-card">
                      <a href={`/search/item/${encodeURIComponent(c.pid)}`} target="_blank" rel="noreferrer nofollow" className="ai-card-img">
                        <img src={`/media/s/${encodeURIComponent(c.pid)}`} alt="" loading="lazy" />
                      </a>
                      <div className="ai-card-title">{c.title}</div>
                      <div className="ai-card-foot">
                        <span className="ai-card-price">{money(c.fromCents)}</span>
                        <button type="button" onClick={() => quickAdd(c)}>
                          Add
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="ai-msg ai-bot ai-thinking">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" /> {progress ?? "Thinking…"}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <p className="ai-error" role="alert">{error}</p>}
      {!configured && <p className="ai-error">The assistant is switched off right now. You can still use search.</p>}

      <form
        className="ai-input"
        onSubmit={(ev) => {
          ev.preventDefault();
          send(input);
        }}
      >
        <label className="sr-only" htmlFor="ai-q">
          Describe what you need
        </label>
        <textarea
          id="ai-q"
          rows={2}
          maxLength={1000}
          value={input}
          placeholder="Describe your project or what you need…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          disabled={!configured}
        />
        <button className="btn primary" disabled={busy || !input.trim() || !configured}>
          {busy ? "…" : "Send"}
        </button>
      </form>
      <div className="ai-bar">
        <Link href="/cart">Cart ({cartCount})</Link>
        {entries.length > 0 && (
          <button type="button" className="link-btn" onClick={reset}>
            New chat
          </button>
        )}
      </div>
      {toast && <div className="ai-toast" role="status">{toast}</div>}
    </div>
  );
}
