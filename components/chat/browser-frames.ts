// The live browser's moving parts that don't need React or the DOM, so they can be tested in Node:
// - letterbox maths: where a frame drawn with `object-fit: contain` sits in its box, a finger's position as a
//   point in the frame (0..1), and how far a drag scrolls the remote page;
// - the reconnect schedule;
// - FrameRenderer: newest-frame-wins decoding (one decode in flight, one pending blob, one ready frame);
// - LiveConnection: the live-view socket's lifecycle (fresh token per try, bounded backoff, terminal states);
// - the phone-sized viewport sent with control (§11), typing as the fewest page edits, and Handoff (a full-screen
//   card's socket passed to the card that replaces it when the reply is saved).
// Contract: docs/frontier-port/CONTRACTS.md §8 (browser transport), §9 (client transports) and §11 (fix round).

export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/* ---------- Letterbox and coordinates ---------- */

/** Where an image of `img` size sits inside `box` with `object-fit: contain` (centred, aspect kept). */
export function containRect(box: Rect, img: Size): Rect | null {
  if (!(box.width > 0 && box.height > 0 && img.w > 0 && img.h > 0)) return null;
  const scale = Math.min(box.width / img.w, box.height / img.h);
  const width = img.w * scale;
  const height = img.h * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/**
 * A point on screen (client px) as a point in the frame, normalized 0..1, or null when it falls in the
 * letterbox bars or outside the box. Device pixel ratio doesn't matter: both sides are CSS px.
 */
export function toFramePoint(clientX: number, clientY: number, box: Rect, img: Size): { x: number; y: number } | null {
  const r = containRect(box, img);
  if (!r) return null;
  const x = (clientX - r.left) / r.width;
  const y = (clientY - r.top) / r.height;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x, y };
}

/**
 * The remote page's size in its own CSS px. The server says it with frame-meta ({w, h}, the page viewport);
 * without that, the frame's pixel size is the best guess, halved for a portrait frame that is clearly a
 * high-density phone capture (390×844 at DPR 2 arrives as 780×1688).
 */
export function pageSize(meta: Size | null, frame: Size | null): Size | null {
  if (meta && meta.w > 0 && meta.h > 0) return meta;
  if (!frame || !(frame.w > 0 && frame.h > 0)) return null;
  if (frame.h > frame.w && frame.w >= 600) return { w: frame.w / 2, h: frame.h / 2 };
  return frame;
}

/** Page CSS px per screen px for a vertical drag over the drawn frame (letterbox-aware). */
export function pagePxPerScreenPx(box: Rect, frame: Size, page: Size | null): number {
  const r = containRect(box, frame);
  if (!r) return 1;
  const p = page && page.h > 0 ? page : frame;
  return p.h / r.height;
}

/** A drag of `screenDy` px (finger moving up is positive) as a page scroll in page CSS px, clamped to ±4000. */
export function scrollDelta(screenDy: number, box: Rect, frame: Size, page: Size | null): number {
  const dy = screenDy * pagePxPerScreenPx(box, frame, page);
  return Math.max(-4000, Math.min(4000, dy));
}

/* ---------- The shopper's screen as the remote phone viewport (§11) ---------- */

/** The range the browser service accepts as a phone viewport (CSS px); it clamps to the same. */
export const PHONE_VIEWPORT = { minW: 320, maxW: 600, minH: 400, maxH: 1100 } as const;

/**
 * The full-screen browser area in whole CSS px, as the phone viewport to ask for: the box's content size (its
 * padding taken off), clamped to what the service accepts. Null for a box that isn't laid out yet. Sending it
 * clamped means a change the service would ignore anyway (the keyboard opening on a short screen) sends nothing.
 */
export function phoneViewport(rect: { width: number; height: number }, pad: { top: number; right: number; bottom: number; left: number } = { top: 0, right: 0, bottom: 0, left: 0 }): Size | null {
  const w = rect.width - (pad.left || 0) - (pad.right || 0);
  const h = rect.height - (pad.top || 0) - (pad.bottom || 0);
  if (!(w >= 1 && h >= 1)) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  return { w: clamp(w, PHONE_VIEWPORT.minW, PHONE_VIEWPORT.maxW), h: clamp(h, PHONE_VIEWPORT.minH, PHONE_VIEWPORT.maxH) };
}

export const sameSize = (a: Size | null, b: Size | null): boolean => (a === null || b === null ? a === b : a.w === b.w && a.h === b.h);

/* ---------- Typing into the page ---------- */

/** Most a single Backspace message may repeat, and the longest text one `type` message may carry (§8, §11). */
export const MAX_BACKSPACES = 200;
export const MAX_TYPE_CHARS = 2000;

/** User-perceived characters (an emoji or an accented letter is one), which is what one Backspace removes. */
export function graphemes(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
  return Array.from(s);
}

export type TypingEdit = { t: "type"; text: string } | { t: "key"; key: "Backspace"; count: number };

/**
 * What to send so the focused field on the page goes from `prev` to `next` (the box mirrors it; the page's
 * caret sits at the end of what was typed): Backspace back to where the two agree, then type the rest. Repeats
 * go as one `{key: "Backspace", count}` (a mid-word fix or an autocorrect rewrite used to send one message per
 * character and overflow the service's input queue), split only past the limits a message may carry.
 */
export function typingEdits(prev: string, next: string): TypingEdit[] {
  if (prev === next) return [];
  const a = graphemes(prev);
  const b = graphemes(next);
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  const out: TypingEdit[] = [];
  for (let left = a.length - k; left > 0; left -= MAX_BACKSPACES) out.push({ t: "key", key: "Backspace", count: Math.min(left, MAX_BACKSPACES) });
  let chunk = "";
  for (const g of b.slice(k)) {
    if (chunk && chunk.length + g.length > MAX_TYPE_CHARS) {
      out.push({ t: "type", text: chunk });
      chunk = "";
    }
    chunk += g;
  }
  if (chunk) out.push({ t: "type", text: chunk });
  return out;
}

/** `s` without its last character (the ⌫ key on what the shopper typed). */
export const dropLast = (s: string): string => graphemes(s).slice(0, -1).join("");

/* ---------- Handing a full-screen card to its replacement ---------- */

/**
 * When the reply being written is saved, its live card unmounts and the saved reply mounts a new card for the
 * same browser. If the shopper is driving full screen at that moment, the old card parks its socket and state
 * here and the new card picks them up in the same commit, so the take-over carries on instead of closing. Nobody
 * picking it up within `ms` (the chat closed, or the saved reply has no card) runs `expire`, which hands control
 * back and closes the socket.
 */
export class Handoff<T> {
  private parked = new Map<string, { value: T; timer: unknown; expire: (value: T) => void }>();
  private readonly timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };

  constructor(timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }) {
    this.timers = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  park(id: string, value: T, expire: (value: T) => void, ms = 1500): void {
    this.expireNow(id);
    const timer = this.timers.set(() => {
      const p = this.parked.get(id);
      if (p?.value !== value) return;
      this.parked.delete(id);
      expire(value);
    }, ms);
    this.parked.set(id, { value, timer, expire });
  }

  /** What's parked for `id`, without taking it (safe to call while rendering). */
  peek(id: string): T | null {
    return this.parked.get(id)?.value ?? null;
  }

  /** Takes what's parked for `id` (it won't expire). */
  take(id: string): T | null {
    const p = this.parked.get(id);
    if (!p) return null;
    this.timers.clear(p.timer);
    this.parked.delete(id);
    return p.value;
  }

  private expireNow(id: string) {
    const p = this.parked.get(id);
    if (!p) return;
    this.timers.clear(p.timer);
    this.parked.delete(id);
    p.expire(p.value);
  }
}

/* ---------- Reconnect schedule ---------- */

/** Wait before reconnect try 1..5 (ms). After the last one: "Tap to reconnect". */
export const RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];

/** The wait before try `attempt` (1-based), or null when the tries are used up. */
export function reconnectDelay(attempt: number, delays: readonly number[] = RECONNECT_DELAYS_MS): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return attempt <= delays.length ? delays[attempt - 1] : null;
}

/* ---------- Frame rendering ---------- */

export interface Decoded {
  width: number;
  height: number;
}

export interface FrameRendererOptions<B, F extends Decoded> {
  /** Blob → something drawable (createImageBitmap in the browser). */
  decode: (blob: B) => Promise<F>;
  /** Paints a decoded frame (called from `schedule`, at most once per frame). */
  draw: (frame: F) => void;
  /** Frees a decoded frame (bitmap.close()). Called exactly once per decoded frame: after drawing, or when dropped. */
  release: (frame: F) => void;
  /** When to paint (requestAnimationFrame in the browser). */
  schedule?: (cb: () => void) => void;
  /** After each paint, with the frame size and whether it was the first one ever. */
  onFrame?: (size: Size, first: boolean) => void;
}

/**
 * Newest-frame-wins rendering: at most one decode runs; frames arriving meanwhile overwrite one pending slot,
 * so a slow phone skips frames instead of falling behind. A decoded frame waits for the next paint; a newer
 * decode replaces it (the older one is released unpainted). Bounded memory: one blob, one decode, one frame.
 */
export class FrameRenderer<B, F extends Decoded> {
  private pending: B | null = null;
  private decoding = false;
  private ready: F | null = null;
  private paintQueued = false;
  private disposed = false;
  private painted = 0;
  private lastSize: Size | null = null;

  constructor(private readonly o: FrameRendererOptions<B, F>) {}

  /** The size of the last painted frame. */
  get size(): Size | null {
    return this.lastSize;
  }
  get hasFrame(): boolean {
    return this.painted > 0;
  }

  push(blob: B): void {
    if (this.disposed) return;
    this.pending = blob;
    this.pump();
  }

  private pump(): void {
    if (this.decoding || this.disposed || this.pending === null) return;
    const blob = this.pending;
    this.pending = null;
    this.decoding = true;
    let p: Promise<F>;
    try {
      p = this.o.decode(blob);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (f) => {
        if (this.disposed) return this.o.release(f);
        if (this.ready) this.o.release(this.ready);
        this.ready = f;
        this.queuePaint();
      },
      () => {
        /* a broken frame is skipped; the next one replaces it */
      },
    ).finally(() => {
      this.decoding = false;
      this.pump();
    });
  }

  private queuePaint(): void {
    if (this.paintQueued) return;
    this.paintQueued = true;
    const run = () => {
      this.paintQueued = false;
      const f = this.ready;
      this.ready = null;
      if (!f) return;
      if (this.disposed) return this.o.release(f);
      try {
        this.o.draw(f);
      } finally {
        this.o.release(f);
      }
      this.painted++;
      this.lastSize = { w: f.width, h: f.height };
      this.o.onFrame?.(this.lastSize, this.painted === 1);
    };
    (this.o.schedule ?? ((cb) => void Promise.resolve().then(cb)))(run);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = null;
    if (this.ready) {
      this.o.release(this.ready);
      this.ready = null;
    }
  }
}

/* ---------- Live-view connection ---------- */

export type ConnState =
  | { s: "idle" }
  | { s: "connecting" }
  | { s: "live" }
  | { s: "reconnecting"; attempt: number; of: number }
  | { s: "offline" }
  | { s: "ended"; reason: string };

/** The parts of a WebSocket LiveConnection uses (a fake in tests). */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** GET /api/assistant/browser → a socket address; `gone` (404) means the browser is closed for good. */
export type TokenResult = { ok: true; url: string } | { ok: false; gone: boolean };

export interface LiveConnectionDeps {
  getToken: (signal: AbortSignal) => Promise<TokenResult>;
  open: (url: string) => SocketLike;
  onState: (s: ConnState) => void;
  /** A parsed JSON message from the browser service. */
  onMessage: (m: Record<string, unknown>) => void;
  /** A binary frame. */
  onFrame: (data: unknown) => void;
  /** The socket opened (re-send control here). */
  onOpen?: () => void;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
  /** False when the device knows it's offline: skip the tries and wait for `retryNow()` (the `online` event). */
  isOnline?: () => boolean;
  delays?: readonly number[];
}

export const CLOSED_REASON = "This browser has closed.";

/**
 * One live view's socket. Wanted only while the card is on screen or expanded. Each try fetches a fresh token
 * (they live 10 minutes); failures back off 0.5, 1, 2, 4, 8 s, then it goes offline until `retryNow()`.
 * `{t:"ended"}` or a 404 for the token ends it for good. The try counter resets once a connection proves
 * healthy (its first message), so a socket that opens and drops at once still backs off.
 */
export class LiveConnection {
  private sock: SocketLike | null = null;
  private abort: AbortController | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private wanted = false;
  private ended = false;
  private disposed = false;
  private gen = 0;
  private st: ConnState = { s: "idle" };
  private readonly timers: NonNullable<LiveConnectionDeps["timers"]>;
  private readonly delays: readonly number[];

  constructor(private readonly d: LiveConnectionDeps) {
    this.timers = d.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.delays = d.delays ?? RECONNECT_DELAYS_MS;
  }

  get state(): ConnState {
    return this.st;
  }
  get isLive(): boolean {
    return this.st.s === "live";
  }

  private set(s: ConnState) {
    const a = this.st;
    if (a.s === s.s && JSON.stringify(a) === JSON.stringify(s)) return;
    this.st = s;
    if (!this.disposed) this.d.onState(s);
  }

  setWanted(want: boolean): void {
    if (this.disposed) return;
    this.wanted = want;
    if (this.ended) return;
    if (!want) {
      this.teardown();
      this.set({ s: "idle" });
      return;
    }
    if (this.sock || this.abort || this.timer !== null || this.st.s === "offline") return;
    this.attempt = 0;
    this.connect();
  }

  /** Try again now (a tap, coming back online, the tab becoming visible). No-op while live or connecting. */
  retryNow(): void {
    if (this.disposed || this.ended || !this.wanted) return;
    if (this.sock || this.abort) return;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.connect();
  }

  /** Sends a JSON message if the socket is open. */
  send(m: unknown): boolean {
    const s = this.sock;
    if (!s || s.readyState !== 1) return false;
    try {
      s.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }

  /** Ends for good (the browser closed). */
  end(reason: string = CLOSED_REASON): void {
    if (this.ended || this.disposed) return;
    this.ended = true;
    this.teardown();
    this.set({ s: "ended", reason: reason || CLOSED_REASON });
  }

  dispose(): void {
    this.teardown();
    this.disposed = true;
  }

  private teardown() {
    this.gen++;
    this.abort?.abort();
    this.abort = null;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
  }

  private connect() {
    const gen = ++this.gen;
    this.set(this.attempt === 0 ? { s: "connecting" } : { s: "reconnecting", attempt: this.attempt, of: this.delays.length });
    const ac = new AbortController();
    this.abort = ac;
    let p: Promise<TokenResult>;
    try {
      p = this.d.getToken(ac.signal);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (r) => {
        if (gen !== this.gen) return;
        this.abort = null;
        if (!r.ok) return r.gone ? this.end(CLOSED_REASON) : this.fail();
        this.openSocket(r.url, gen);
      },
      () => {
        if (gen !== this.gen) return;
        this.abort = null;
        this.fail();
      },
    );
  }

  private openSocket(url: string, gen: number) {
    let s: SocketLike;
    try {
      s = this.d.open(url);
      s.binaryType = "blob";
    } catch {
      return this.fail();
    }
    this.sock = s;
    let healthy = false;
    s.onopen = () => {
      if (gen !== this.gen) return;
      this.set({ s: "live" });
      this.d.onOpen?.();
    };
    s.onmessage = (ev) => {
      if (gen !== this.gen) return;
      if (!healthy) {
        healthy = true;
        this.attempt = 0;
      }
      if (typeof ev.data === "string") {
        let m: unknown;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!m || typeof m !== "object") return;
        const msg = m as Record<string, unknown>;
        this.d.onMessage(msg);
        if (msg.t === "ended") this.end(typeof msg.reason === "string" && msg.reason ? msg.reason : CLOSED_REASON);
        return;
      }
      this.d.onFrame(ev.data);
    };
    s.onclose = () => {
      if (gen !== this.gen) return;
      this.sock = null;
      if (this.ended) return;
      if (!this.wanted) return this.set({ s: "idle" });
      this.fail();
    };
    s.onerror = () => {
      /* a close always follows */
    };
  }

  private fail() {
    if (this.ended || this.disposed) return;
    this.sock = null;
    if (!this.wanted) return this.set({ s: "idle" });
    if (this.d.isOnline && !this.d.isOnline()) return this.set({ s: "offline" });
    this.attempt++;
    const wait = reconnectDelay(this.attempt, this.delays);
    if (wait === null) return this.set({ s: "offline" });
    this.set({ s: "reconnecting", attempt: this.attempt, of: this.delays.length });
    const gen = this.gen;
    this.timer = this.timers.set(() => {
      if (gen !== this.gen) return;
      this.timer = null;
      this.connect();
    }, wait);
  }
}
