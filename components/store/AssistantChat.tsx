"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Card {
  pid: string;
  title: string;
  fromCents: number;
  group?: string;
}
interface Option {
  id: string;
  name: string;
  priceCents: number;
  available: boolean;
  stock: string;
}
interface LiveGroup {
  group: string;
  cards: Card[];
  done: boolean;
}
interface KitItem {
  part: string;
  pid: string;
  title: string;
  fromCents: number;
  quantity: number;
  option?: string;
}
interface Kit {
  id: string;
  name: string;
  items: KitItem[];
}
/** `steps` and `groups` are only kept in the browser, to show how the answer was found. */
type BotEntry = { role: "assistant"; text: string; cards: Card[]; added: string[]; kit?: Kit; steps?: string[]; groups?: LiveGroup[]; stopped?: boolean };
type Entry = { role: "user"; text: string } | BotEntry;
interface Turn {
  text: string;
  steps: string[];
  groups: LiveGroup[];
}
interface KitState {
  busy: boolean;
  done: number;
  total: number;
  results?: Array<{ part: string; title: string; ok: boolean; message: string }>;
  error?: string;
}

const EXAMPLES = [
  "Battery setup for a custom 48V e-bike, plus the tools to build it",
  "Stock a small café: 200 compostable cups, lids and a milk frother",
  "Solar kit to run a fridge and lights in a cabin",
  "Everything to start screen-printing t-shirts at home",
];

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function groupCards(cards: Card[]): Array<[string, Card[]]> {
  const m = new Map<string, Card[]>();
  for (const c of cards) m.set(c.group ?? "", [...(m.get(c.group ?? "") ?? []), c]);
  return [...m];
}

/** Reads an NDJSON response line by line. */
async function readNdjson(r: Response, onEvent: (ev: Record<string, any>) => void) {
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

/* ---------- Markdown: headings, lists, bold, code, links. Built as React nodes, never raw HTML. ---------- */

function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("**")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const safe = /^(\/(?!\/)|https?:\/\/)/.test(href);
      out.push(safe ? <a key={k} href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noreferrer nofollow">{label}</a> : label);
    }
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) {
      const k = blocks.length;
      blocks.push(
        <p key={k}>
          {para.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {inline(l, j)}
            </Fragment>
          ))}
        </p>,
      );
      para = [];
    }
    if (list) {
      const k = blocks.length;
      const items = list.items.map((it, j) => <li key={j}>{inline(it, j)}</li>);
      blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
      list = null;
    }
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!l.trim()) {
      flush();
      continue;
    }
    const h = l.match(/^#{1,4}\s+(.*)$/);
    const ul = l.match(/^\s*[-*•]\s+(.*)$/);
    const ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) {
      flush();
      blocks.push(<h4 key={blocks.length}>{inline(h[1].replace(/\*\*/g, ""))}</h4>);
    } else if (ul || ol) {
      if (para.length) flush();
      const ordered = !!ol;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((ul ?? ol)![1]);
    } else if (list && /^\s{2,}/.test(raw)) {
      list.items[list.items.length - 1] += " " + l.trim();
    } else {
      if (list) flush();
      para.push(l);
    }
  }
  flush();
  return <div className="cx-md">{blocks}</div>;
}

/* ---------- Icons ---------- */

const ArrowUp = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
    <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
  </svg>
);
const CopyIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);
const RetryIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const DownIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </svg>
);
const Spinner = () => <span className="cx-spin" aria-hidden />;
const Logo = () => (
  <span className="cx-logo" aria-hidden>
    1
  </span>
);

/* ---------- Steps: what the assistant did, collapsible like a tool-use log ---------- */

function Steps({ steps, groups, live }: { steps: string[]; groups: LiveGroup[]; live: boolean }) {
  if (!steps.length && !groups.length) return null;
  const searched = groups.length;
  const found = groups.reduce((n, g) => n + g.cards.length, 0);
  const summary = live ? steps[steps.length - 1] ?? "Thinking…" : searched ? `Searched ${searched} categor${searched === 1 ? "y" : "ies"} · ${found} products` : `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return (
    <details className={`cx-steps${live ? " is-live" : ""}`} open={live || undefined}>
      <summary>
        {live ? <Spinner /> : <span className="cx-step-dot" aria-hidden />}
        <span className="cx-steps-sum">{summary}</span>
      </summary>
      <div className="cx-steps-body">
        {groups.length > 0 && (
          <div className="cx-live-groups">
            {groups.map((g) => (
              <div key={g.group} className={`cx-live${g.done ? " cx-live-ok" : ""}`}>
                <div className="cx-live-head">
                  {g.done ? <span className="cx-check" aria-hidden>✓</span> : <Spinner />}
                  <strong>{g.group}</strong>
                  <span className="cx-muted">{g.done ? `${g.cards.length} shortlisted` : `${g.cards.length} found`}</span>
                </div>
                {g.cards.length > 0 && (
                  <div className="cx-live-row">
                    {g.cards.map((c) => (
                      <img key={c.pid} src={`/media/s/${encodeURIComponent(c.pid)}`} alt="" title={`${c.title} · ${money(c.fromCents)}`} loading="lazy" />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {!live && steps.length > 0 && (
          <ol className="cx-step-list">
            {steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

export default function AssistantChat() {
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [input, setInput] = useState("");
  const [turn, setTurn] = useState<Turn | null>(null);
  const [error, setError] = useState<{ message: string; retry: string } | null>(null);
  const [cartCount, setCartCount] = useState(0);
  const [toast, setToast] = useState<{ text: string; cart?: boolean } | null>(null);
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [addedPids, setAddedPids] = useState<Record<string, boolean>>({});
  const [kitState, setKitState] = useState<Record<string, KitState>>({});
  const [picking, setPicking] = useState<Record<string, { options: Option[]; selected?: string }>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stick = useRef(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const busy = turn !== null;
  const empty = loaded && entries.length === 0 && !busy;

  useEffect(() => {
    fetch("/api/assistant")
      .then((r) => r.json())
      .then((d) => {
        setEntries(d.entries ?? []);
        setConfigured(d.configured !== false);
        setCartCount(d.cartCount ?? 0);
      })
      .catch(() => null)
      .finally(() => setLoaded(true));
    // Focus the composer on desktop; on phones that would pop the keyboard over the page.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, []);

  // Follow the conversation while the reader is at the bottom; stop following when they scroll up.
  useEffect(() => {
    const onScroll = () => {
      const el = rootRef.current;
      const near = !el || el.getBoundingClientRect().bottom <= window.innerHeight + 160;
      stick.current = near;
      setAtBottom(near);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const scrollToEnd = useCallback((smooth = false) => {
    const el = rootRef.current;
    if (!el) return;
    const top = window.scrollY + el.getBoundingClientRect().bottom - window.innerHeight;
    if (top > window.scrollY || smooth) window.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  }, []);
  useLayoutEffect(() => {
    if (stick.current && (entries.length || turn)) scrollToEnd();
  }, [entries, turn, scrollToEnd]);

  // Esc stops a running answer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && abortRef.current) abortRef.current.abort();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Grow the composer with its text.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input, empty]);

  const flash = useCallback((text: string, cart = false) => {
    setToast({ text, cart });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || busy || !configured) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    stick.current = true;
    setError(null);
    setInput("");
    setEntries((e) => [...e, { role: "user", text: msg }]);
    const t: Turn = { text: "", steps: [], groups: [] };
    setTurn({ ...t });
    const update = () => setTurn({ text: t.text, steps: [...t.steps], groups: [...t.groups] });
    let finished = false;
    try {
      const r = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg }), signal: ctrl.signal });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Something went wrong.");
      }
      await readNdjson(r, (ev) => {
        if (ev.type === "progress") {
          if (t.steps[t.steps.length - 1] !== ev.note) t.steps.push(ev.note);
          update();
        } else if (ev.type === "text") {
          t.text += ev.delta;
          update();
        } else if (ev.type === "break") {
          if (t.text && !t.text.endsWith("\n\n")) t.text += "\n\n";
          update();
        } else if (ev.type === "found") {
          const prev = t.groups.find((x) => x.group === ev.group);
          // While searching, accumulate finds; when the scout is done, show its shortlist.
          const cards: Card[] = ev.done
            ? ev.cards.length ? ev.cards : prev?.cards.slice(0, 3) ?? []
            : [...(prev?.cards ?? []), ...ev.cards.filter((c: Card) => !prev?.cards.some((p) => p.pid === c.pid))].slice(0, 8);
          const next = { group: ev.group, cards, done: ev.done };
          t.groups = prev ? t.groups.map((x) => (x.group === ev.group ? next : x)) : [...t.groups, next];
          update();
        } else if (ev.type === "error") throw new Error(ev.error);
        else if (ev.type === "done") {
          finished = true;
          setEntries((e) => [...e, { ...ev.entry, steps: t.steps, groups: t.groups }]);
          setCartCount(ev.cartCount ?? 0);
          if (ev.entry?.added?.length) router.refresh();
        }
      });
      if (!finished) {
        // The server finishes the turn even if the connection drops; pick up the saved answer.
        for (let i = 0; i < 30 && !finished; i++) {
          await new Promise((res) => setTimeout(res, 2500));
          if (ctrl.signal.aborted) throw new DOMException("Stopped", "AbortError");
          const d = await fetch("/api/assistant").then((x) => x.json()).catch(() => null);
          const n = d?.entries?.length ?? 0;
          if (n >= 2 && d.entries[n - 1].role === "assistant" && d.entries[n - 2].text === msg) {
            finished = true;
            setEntries(d.entries);
            setCartCount(d.cartCount ?? 0);
          }
        }
        if (!finished) throw new Error("The connection dropped before the answer arrived.");
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        // Keep what was written so far, like stopping a reply in Claude.
        setEntries((en) => [...en, { role: "assistant", text: t.text, cards: [], added: [], steps: t.steps, groups: t.groups, stopped: true }]);
      } else {
        setError({ message: e instanceof Error ? e.message : "Something went wrong.", retry: msg });
      }
    } finally {
      abortRef.current = null;
      setTurn(null);
    }
  }

  function retry(msg: string) {
    // Drop the failed (or stopped) exchange and ask again.
    setEntries((e) => {
      const i = e.map((x) => x.role === "user" && x.text === msg).lastIndexOf(true);
      return i >= 0 ? e.slice(0, i) : e;
    });
    setError(null);
    setTimeout(() => send(msg), 0);
  }

  async function quickAdd(card: Card, variantId?: string) {
    setAdding((a) => ({ ...a, [card.pid]: true }));
    try {
      const r = await fetch("/api/assistant/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(variantId ? { variantId } : { pid: card.pid }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.choose) {
        setPicking((p) => ({ ...p, [card.pid]: { options: d.options, selected: d.options.find((o: Option) => o.available)?.id ?? d.options[0]?.id } }));
        return;
      }
      if (typeof d.cartCount === "number") setCartCount(d.cartCount);
      if (d.ok) {
        setAddedPids((a) => ({ ...a, [card.pid]: true }));
        setPicking((p) => {
          const n = { ...p };
          delete n[card.pid];
          return n;
        });
        router.refresh();
      }
      flash(d.message ?? (d.ok ? "Added to cart" : "Couldn’t add that"), !!d.ok);
    } catch {
      flash("Couldn’t add that. Please try again.");
    } finally {
      setAdding((a) => ({ ...a, [card.pid]: false }));
    }
  }

  async function addKit(kit: Kit) {
    setKitState((k) => ({ ...k, [kit.id]: { busy: true, done: 0, total: kit.items.length } }));
    try {
      const r = await fetch("/api/assistant/kit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kitId: kit.id }) });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Couldn’t add the kit.");
      }
      await readNdjson(r, (ev) => {
        if (ev.type === "item") setKitState((k) => ({ ...k, [kit.id]: { ...k[kit.id], done: ev.done, total: ev.total } }));
        else if (ev.type === "done") {
          setKitState((k) => ({ ...k, [kit.id]: { busy: false, done: ev.results.length, total: ev.results.length, results: ev.results } }));
          setCartCount(ev.cartCount ?? 0);
          const ok = ev.results.filter((x: { ok: boolean }) => x.ok).length;
          flash(`Added ${ok} of ${ev.results.length} items`, ok > 0);
          router.refresh();
        } else if (ev.type === "error") throw new Error(ev.error);
      });
    } catch (e) {
      setKitState((k) => ({ ...k, [kit.id]: { busy: false, done: 0, total: kit.items.length, error: e instanceof Error ? e.message : "Couldn’t add the kit." } }));
    }
  }

  async function reset() {
    abortRef.current?.abort();
    setEntries([]);
    setError(null);
    setInput("");
    inputRef.current?.focus();
    await fetch("/api/assistant", { method: "DELETE" }).catch(() => null);
  }

  async function copy(i: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500);
    } catch {
      flash("Couldn’t copy");
    }
  }

  const lastUser = [...entries].reverse().find((e) => e.role === "user")?.text;

  const composer = (
    <form
      className={`cx-composer${busy ? " is-busy" : ""}`}
      onSubmit={(ev) => {
        ev.preventDefault();
        send(input);
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <label className="sr-only" htmlFor="cx-q">
        Describe what you need
      </label>
      <textarea
        id="cx-q"
        ref={inputRef}
        rows={1}
        maxLength={1000}
        value={input}
        enterKeyHint="send"
        placeholder={entries.length ? "Reply…" : "Describe your project or what you need…"}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send(input);
          }
        }}
        disabled={!configured}
      />
      <div className="cx-composer-bar">
        <span className="cx-hint">{busy ? "Esc to stop" : "Enter to send · Shift+Enter for a new line"}</span>
        {busy ? (
          <button type="button" className="cx-send cx-stop" onClick={() => abortRef.current?.abort()} aria-label="Stop">
            <StopIcon />
          </button>
        ) : (
          <button type="submit" className="cx-send" disabled={!input.trim() || !configured} aria-label="Send">
            <ArrowUp />
          </button>
        )}
      </div>
    </form>
  );

  if (empty) {
    return (
      <div className="cx cx-empty">
        <div className="cx-hello">
          <Logo />
          <h1>What are you building?</h1>
          <p>Describe the project. I’ll work out the parts list, find each item from Chinese factories and fill your cart, with shipping to Canada shown before you pay.</p>
        </div>
        {composer}
        {!configured && <p className="cx-err">The assistant is switched off right now. You can still use <Link href="/search">search</Link>.</p>}
        <div className="cx-examples">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="cx-example" onClick={() => send(x)} disabled={!configured}>
              {x}
            </button>
          ))}
        </div>
        <p className="cx-meta">
          <Link href="/boxes">Mystery boxes</Link>
          <span aria-hidden>·</span>
          <Link href="/search">Search the catalog</Link>
          <span aria-hidden>·</span>
          <Link href="/cart">Cart ({cartCount})</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="cx" ref={rootRef}>
      <div className="cx-col" aria-live="polite">
        {!loaded && <div className="cx-loading"><Spinner /></div>}
        {entries.map((e, i) =>
          e.role === "user" ? (
            <div key={i} className="cx-msg cx-user">
              <div className="cx-bubble">{e.text}</div>
            </div>
          ) : (
            <div key={i} className="cx-msg cx-bot">
              <Logo />
              <div className="cx-bot-body">
                {e.steps && <Steps steps={e.steps} groups={e.groups ?? []} live={false} />}
                {e.text ? <Markdown text={e.text} /> : e.stopped ? null : <p className="cx-muted">No reply.</p>}
                {e.stopped && <p className="cx-stopped">Stopped. The answer may still finish in the background; reload to see it.</p>}
                {e.added.length > 0 && (
                  <div className="cx-added">
                    {e.added.map((a) => (
                      <div key={a}>
                        <span className="cx-check" aria-hidden>✓</span> Added {a}
                      </div>
                    ))}
                    <Link href="/cart" className="cx-link">
                      Review cart →
                    </Link>
                  </div>
                )}
                {e.kit && <KitCard kit={e.kit} state={kitState[e.kit.id]} onAdd={() => addKit(e.kit!)} />}
                {groupCards(e.cards).map(([group, cards]) => (
                  <div key={group || "all"} className="cx-group">
                    {group && <div className="cx-group-label">{group}</div>}
                    <div className="cx-cards">
                      {cards.map((c) => (
                        <ProductCard
                          key={c.pid}
                          card={c}
                          adding={!!adding[c.pid]}
                          added={!!addedPids[c.pid]}
                          pick={picking[c.pid]}
                          onPick={(id) => setPicking((p) => ({ ...p, [c.pid]: { ...p[c.pid], selected: id } }))}
                          onAdd={(vid) => quickAdd(c, vid)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div className="cx-actions">
                  <button type="button" className="cx-icon-btn" onClick={() => copy(i, e.text)} aria-label="Copy reply" title="Copy">
                    {copied === i ? <span className="cx-check">✓</span> : <CopyIcon />}
                  </button>
                  {i === entries.length - 1 && lastUser && !busy && (
                    <button type="button" className="cx-icon-btn" onClick={() => retry(lastUser)} aria-label="Ask again" title="Ask again">
                      <RetryIcon />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ),
        )}

        {turn && (
          <div className="cx-msg cx-bot">
            <Logo />
            <div className="cx-bot-body">
              <Steps steps={turn.steps.length ? turn.steps : ["Thinking…"]} groups={turn.groups} live />
              {turn.text ? (
                <div className="cx-streaming">
                  <Markdown text={turn.text} />
                </div>
              ) : (
                <div className="cx-typing" aria-label="Working">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="cx-error" role="alert">
            <span>{error.message}</span>
            <button type="button" className="cx-btn" onClick={() => retry(error.retry)}>
              <RetryIcon /> Try again
            </button>
          </div>
        )}
      </div>

      <div className="cx-dock">
        {!atBottom && (
          <button type="button" className="cx-jump" onClick={() => scrollToEnd(true)} aria-label="Jump to latest">
            <DownIcon />
          </button>
        )}
        {composer}
        <div className="cx-dock-meta">
          <button type="button" className="cx-link-btn" onClick={reset}>
            <PlusIcon /> New chat
          </button>
          <Link href="/cart" className={`cx-cart${cartCount ? " has-items" : ""}`}>
            Cart{cartCount ? ` · ${cartCount}` : ""}
          </Link>
        </div>
      </div>

      {toast && (
        <div className="cx-toast" role="status">
          {toast.text}
          {toast.cart && <Link href="/cart">View cart</Link>}
        </div>
      )}
    </div>
  );
}

function ProductCard({
  card: c,
  adding,
  added,
  pick,
  onPick,
  onAdd,
}: {
  card: Card;
  adding: boolean;
  added: boolean;
  pick?: { options: Option[]; selected?: string };
  onPick: (id: string) => void;
  onAdd: (variantId?: string) => void;
}) {
  return (
    <div className="cx-card">
      <a href={`/search/item/${encodeURIComponent(c.pid)}`} target="_blank" rel="noreferrer nofollow" className="cx-card-img">
        <img src={`/media/s/${encodeURIComponent(c.pid)}`} alt="" loading="lazy" />
      </a>
      <div className="cx-card-title" title={c.title}>
        {c.title}
      </div>
      {pick ? (
        <div className="cx-pick">
          <label className="sr-only" htmlFor={`opt-${c.pid}`}>
            Option
          </label>
          <select id={`opt-${c.pid}`} value={pick.selected} onChange={(ev) => onPick(ev.target.value)}>
            {pick.options.map((o) => (
              <option key={o.id} value={o.id} disabled={!o.available}>
                {o.name} · {money(o.priceCents)}
                {o.available ? "" : " (sold out)"}
              </option>
            ))}
          </select>
          <button type="button" className="cx-btn cx-btn-primary" disabled={adding || !pick.selected} onClick={() => onAdd(pick.selected)}>
            {adding ? <Spinner /> : "Add"}
          </button>
        </div>
      ) : (
        <div className="cx-card-foot">
          <span className="cx-price">{money(c.fromCents)}</span>
          <button type="button" className={`cx-btn cx-btn-primary${added ? " is-done" : ""}`} disabled={adding} onClick={() => onAdd()} aria-label={`Add ${c.title} to cart`}>
            {adding ? <Spinner /> : added ? "✓ Added" : "Add"}
          </button>
        </div>
      )}
    </div>
  );
}

function KitCard({ kit, state, onAdd }: { kit: Kit; state?: KitState; onAdd: () => void }) {
  const total = kit.items.reduce((n, i) => n + i.fromCents * i.quantity, 0);
  const pct = state?.busy && state.total ? Math.round((state.done / state.total) * 100) : 0;
  return (
    <div className="cx-kit">
      <div className="cx-kit-head">
        <span className="cx-kit-badge">Kit</span>
        <strong>{kit.name}</strong>
        <span className="cx-muted">{kit.items.length} items</span>
      </div>
      <ul className="cx-kit-list">
        {kit.items.map((it) => {
          const r = state?.results?.find((x) => x.part === it.part && x.title === it.title);
          return (
            <li key={it.part + it.pid} className={r ? (r.ok ? "ok" : "fail") : ""}>
              <img src={`/media/s/${encodeURIComponent(it.pid)}`} alt="" loading="lazy" />
              <span className="cx-kit-text">
                <span className="cx-kit-part">{it.part}</span>
                <span className="cx-kit-title">
                  {it.title}
                  {it.option ? <span className="cx-muted"> · {it.option}</span> : null}
                  {r && !r.ok ? <span className="cx-kit-err"> · {r.message}</span> : null}
                </span>
              </span>
              <span className="cx-kit-qty">
                {r ? (r.ok ? "✓ " : "✗ ") : ""}
                {it.quantity} × {money(it.fromCents)}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="cx-kit-foot">
        <span>
          From <strong>{money(total)}</strong>
          <span className="cx-muted"> + shipping</span>
        </span>
        {state?.results ? (
          <Link href="/cart" className="cx-btn cx-btn-primary cx-btn-lg is-done">
            {state.results.every((x) => x.ok) ? "✓ Added · View cart" : "View cart"}
          </Link>
        ) : (
          <button type="button" className="cx-btn cx-btn-primary cx-btn-lg" disabled={state?.busy} onClick={onAdd}>
            {state?.busy ? (
              <>
                <Spinner /> Adding {state.done}/{state.total}
              </>
            ) : (
              "Add entire kit to cart"
            )}
          </button>
        )}
      </div>
      {state?.busy && (
        <div className="cx-progress" aria-hidden>
          <span style={{ width: `${Math.max(6, pct)}%` }} />
        </div>
      )}
      {state?.error && <p className="cx-kit-err">{state.error}</p>}
    </div>
  );
}
