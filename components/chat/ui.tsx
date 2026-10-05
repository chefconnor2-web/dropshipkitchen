"use client";
// Shared pieces of the assistant chat: types, markdown, icons, step log, product and kit cards.

import { Fragment, type ReactNode } from "react";
import ShipBadge from "@/components/ShipBadge";
import Link from "next/link";

export interface Card {
  pid: string;
  title: string;
  fromCents: number;
  group?: string;
}
export interface Option {
  id: string;
  name: string;
  priceCents: number;
  available: boolean;
  stock: string;
}
export interface LiveGroup {
  group: string;
  cards: Card[];
  done: boolean;
}
export interface KitItem {
  part: string;
  pid: string;
  title: string;
  fromCents: number;
  quantity: number;
  option?: string;
}
export interface Kit {
  id: string;
  name: string;
  items: KitItem[];
}
/** `steps` and `groups` are only kept in the browser, to show how the answer was found. */
export type BotEntry = { role: "assistant"; text: string; cards: Card[]; added: string[]; kit?: Kit; steps?: string[]; groups?: LiveGroup[]; stopped?: boolean; at?: string };
/** reaction: the assistant's emoji tapback on this message; at: when it was sent (ISO). */
export type UserEntry = { role: "user"; text: string; images?: string[]; reaction?: string; at?: string };
export type Entry = UserEntry | BotEntry;
export interface Turn {
  text: string;
  steps: string[];
  groups: LiveGroup[];
}
export interface KitState {
  busy: boolean;
  done: number;
  total: number;
  results?: Array<{ part: string; title: string; ok: boolean; message: string }>;
  error?: string;
}

// Everyday asks first (for people who've never used an assistant like this), then bigger projects.
export const EXAMPLES = [
  "A gift for my dad who loves grilling, under $50",
  "Stock a small café: 200 compostable cups, lids and a milk frother",
  "Everything for a road trip with two kids",
  "Battery setup for a custom 48V e-bike, plus the tools to build it",
];

/** iMessage-style timestamp: "Today 2:14 PM", "Yesterday 9:02 AM", "Monday 9:02 AM", "Oct 3, 2026 at 9:02 AM". */
export function stampLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString("en-US", { weekday: "long" })} ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} at ${time}`;
}

/** A timestamp goes above the first message and above any message sent an hour or more after the one before. */
export function showStamp(entries: Array<{ at?: string }>, i: number): string | null {
  const at = entries[i]?.at;
  if (!at) return null;
  const prev = [...entries.slice(0, i)].reverse().find((e) => e.at)?.at;
  return !prev || new Date(at).getTime() - new Date(prev).getTime() >= 3600_000 ? at : null;
}

export function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function groupCards(cards: Card[]): Array<[string, Card[]]> {
  const m = new Map<string, Card[]>();
  for (const c of cards) m.set(c.group ?? "", [...(m.get(c.group ?? "") ?? []), c]);
  return [...m];
}

/** Reads an NDJSON response line by line. */
export async function readNdjson(r: Response, onEvent: (ev: Record<string, any>) => void) {
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

export function inline(s: string, key = 0): ReactNode[] {
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

export function Markdown({ text }: { text: string }) {
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

export const ArrowUp = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
export const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
    <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
  </svg>
);
export const CopyIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);
export const RetryIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
export const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const DownIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </svg>
);
const icon = (d: ReactNode, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
export const MicIcon = () => icon(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>);
export const PlusIcon2 = () => icon(<path d="M12 5v14M5 12h14" />, 20);
export const WaveIcon = () => icon(<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />);
export const ClipIcon = () => icon(<path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />);
export const SpeakerIcon = () => icon(<><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></>, 15);
export const PencilIcon = () => icon(<path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />, 15);
export const XIcon = ({ size = 16 }: { size?: number }) => icon(<path d="M6 6l12 12M18 6 6 18" />, size);
export const MenuIcon = () => icon(<path d="M4 7h16M4 12h16M4 17h10" />, 20);
export const SidebarIcon = () => icon(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>, 20);
export const NewChatIcon = () => icon(<><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 8 16l1.2-4 9.2-9.4Z" /></>, 19);
export const SearchIcon = () => icon(<><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>, 16);
export const DotsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);
export const BagIcon = () => icon(<><path d="M6 7h12l-1 13H7L6 7Z" /><path d="M9 7a3 3 0 0 1 6 0" /></>, 17);
export const GridIcon = () => icon(<><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>, 17);
export const GiftIcon = () => icon(<><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v8h14v-8M12 8v12M12 8S10.5 3 8 4.5 9 8 12 8Zm0 0s1.5-5 4-3.5S15 8 12 8Z" /></>, 17);

export const Spinner = () => <span className="cx-spin" aria-hidden />;
export const Logo = () => (
  <span className="cx-logo" aria-hidden>
    1
  </span>
);

/* ---------- Steps: what the assistant did, collapsible like a tool-use log ---------- */

export function Steps({ steps, groups, live }: { steps: string[]; groups: LiveGroup[]; live: boolean }) {
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

export function ProductCard({
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
      <ShipBadge pid={c.pid} />
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
            {added ? "✓ Added" : adding ? <Spinner /> : "Add"}
          </button>
        </div>
      )}
    </div>
  );
}

export function KitCard({ kit, state, onAdd }: { kit: Kit; state?: KitState; onAdd: () => void }) {
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
