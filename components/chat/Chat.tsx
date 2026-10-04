"use client";
// One conversation with the sourcing assistant: streamed answers, photos, voice, edit and regenerate.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import DesignModal from "./DesignModal";
import type { ChatDesigner } from "@/lib/personalize";
import {
  ArrowUp,
  ClipIcon,
  CopyIcon,
  DownIcon,
  EXAMPLES,
  KitCard,
  Logo,
  Markdown,
  MicIcon,
  PencilIcon,
  ProductCard,
  RetryIcon,
  SpeakerIcon,
  Spinner,
  Steps,
  StopIcon,
  WaveIcon,
  XIcon,
  groupCards,
  readNdjson,
  type Card,
  type Entry,
  type KitState,
  type Kit,
  type Option,
  type Turn,
} from "./ui";
import { imageUrl, uploadImage } from "./images";
import { listen, speak, speechInputSupported, speechOutputSupported, stopSpeaking, unlockSpeech, type Recognizer } from "./voice";
import VoiceMode from "./VoiceMode";

interface Attachment {
  key: string;
  preview: string;
  id?: string;
  error?: string;
}

export interface ChatEvents {
  /** The server created a chat for the first message. */
  onCreated: (id: string, title: string) => void;
  onTitle: (id: string, title: string) => void;
  /** A chat got a new message (moves it to the top of the sidebar). */
  onTouched: (id: string) => void;
  /** The chat in the URL doesn't exist (deleted, or another browser's). */
  onMissing: () => void;
  onCart: (count: number) => void;
}

export default function Chat({ chatId, configured, cartCount, events }: { chatId: string | null; configured: boolean; cartCount: number; events: ChatEvents }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(chatId !== null);
  const [input, setInput] = useState("");
  const [turn, setTurn] = useState<Turn | null>(null);
  const [error, setError] = useState<{ message: string; retryIndex: number; limit?: { subscriber: boolean; signedIn: boolean } } | null>(null);
  const [allowance, setAllowance] = useState<{ remaining: number; limit: number; subscriber: boolean } | null>(null);
  const [toast, setToast] = useState<{ text: string; cart?: boolean } | null>(null);
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [addedPids, setAddedPids] = useState<Record<string, boolean>>({});
  const [kitState, setKitState] = useState<Record<string, KitState>>({});
  const [picking, setPicking] = useState<Record<string, { options: Option[]; selected?: string }>>({});
  const [designing, setDesigning] = useState<{ pid: string; designer: ChatDesigner } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [speakingIdx, setSpeakingIdx] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [canListen, setCanListen] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const run = useRef<{ ctrl: AbortController; detached: boolean } | null>(null);
  const activeId = useRef<string | null | undefined>(undefined);
  const cache = useRef(new Map<string, Entry[]>());
  const stick = useRef(true);
  const rec = useRef<Recognizer | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragDepth = useRef(0);
  const ev = useRef(events);
  const cartRef = useRef(cartCount);
  cartRef.current = cartCount;
  const pendingAdds = useRef(0);
  const setCart = (n: number) => {
    cartRef.current = n;
    ev.current.onCart(n);
  };
  ev.current = events;

  const busy = turn !== null;
  const uploading = attachments.some((a) => !a.id && !a.error);
  const ready = attachments.filter((a) => a.id).map((a) => a.id!);
  const empty = !loading && entries.length === 0 && !busy;

  useEffect(() => {
    setCanListen(speechInputSupported());
    setCanSpeak(speechOutputSupported());
  }, []);

  const flash = useCallback((text: string, cart = false) => {
    setToast({ text, cart });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const focusComposer = useCallback(() => {
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, []);

  // Switch conversations when the URL changes. A chat this component just created is already on screen.
  useEffect(() => {
    if (chatId === activeId.current) return;
    if (run.current) {
      // Leave the running answer to finish on the server; it'll be there when this chat is reopened.
      run.current.detached = true;
      run.current.ctrl.abort();
      run.current = null;
    }
    activeId.current = chatId;
    stopSpeaking();
    setSpeakingIdx(null);
    setTurn(null);
    setError(null);
    setEditing(null);
    setAddedPids({});
    stick.current = true;
    if (!chatId) {
      setEntries([]);
      setLoading(false);
      focusComposer();
      // How many AI messages this shopper has left (shown under the composer).
      fetch("/api/assistant")
        .then((r) => r.json())
        .then((d) => d.allowance && setAllowance(d.allowance))
        .catch(() => null);
      return;
    }
    const cached = cache.current.get(chatId);
    setEntries(cached ?? []);
    setLoading(!cached);
    fetch(`/api/assistant?chat=${encodeURIComponent(chatId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (activeId.current !== chatId) return;
        if (!d.chat) return ev.current.onMissing();
        setEntries(d.entries ?? []);
        ev.current.onCart(d.cartCount ?? 0);
        if (d.allowance) setAllowance(d.allowance);
      })
      .catch(() => null)
      .finally(() => activeId.current === chatId && setLoading(false));
    focusComposer();
  }, [chatId, focusComposer]);

  useEffect(() => {
    if (activeId.current) cache.current.set(activeId.current, entries);
  }, [entries]);

  // Follow the answer while the reader is at the bottom; stop following when they scroll up.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    stick.current = near;
    setAtBottom(near);
  };
  const scrollToEnd = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);
  useLayoutEffect(() => {
    if (stick.current) scrollToEnd();
  }, [entries, turn, error, scrollToEnd]);

  // Esc stops a running answer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && run.current && !voiceMode) run.current.ctrl.abort();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voiceMode]);

  // Grow the composer with its text.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [input, empty]);

  /** Sends one message; resolves with the reply text (for voice mode), or null if it didn't finish. */
  async function send(text: string, opts: { voice?: boolean; editIndex?: number; images?: string[] } = {}): Promise<string | null> {
    const msg = text.trim();
    const images = opts.images ?? ready;
    if ((!msg && !images.length) || busy || !configured) return null;
    if (!opts.images && uploading) {
      flash("Wait for the photo to finish uploading");
      return null;
    }
    rec.current?.stop();
    stopSpeaking();
    setSpeakingIdx(null);
    const me = { ctrl: new AbortController(), detached: false };
    run.current = me;
    let id = activeId.current ?? null;
    stick.current = true;
    setError(null);
    setEditing(null);
    if (!opts.images) {
      setInput("");
      setAttachments([]);
    }
    const userIndex = opts.editIndex ?? entries.length;
    setEntries((e) => [...e.slice(0, userIndex), { role: "user", text: msg, ...(images.length ? { images } : {}) }]);
    const t: Turn = { text: "", steps: [], groups: [] };
    setTurn({ ...t });
    const update = () => !me.detached && setTurn({ text: t.text, steps: [...t.steps], groups: [...t.groups] });
    let reply: string | null = null;
    try {
      const r = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: msg, chatId: id ?? undefined, images, voice: !!opts.voice, editIndex: opts.editIndex }),
        signal: me.ctrl.signal,
      });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        if (d.limit) {
          setAllowance((a) => (a ? { ...a, remaining: 0 } : a));
          throw Object.assign(new Error(d.error), { limit: d.limit });
        }
        throw new Error(d.error || "Something went wrong.");
      }
      await readNdjson(r, (e) => {
        if (e.type === "done" && e.allowance) setAllowance(e.allowance);
        if (e.type === "chat") {
          if (!id) {
            id = e.id as string;
            if (!me.detached) activeId.current = id;
            ev.current.onCreated(id, e.title);
          }
        } else if (e.type === "title") ev.current.onTitle(e.id, e.title);
        else if (e.type === "progress") {
          if (t.steps[t.steps.length - 1] !== e.note) t.steps.push(e.note);
          update();
        } else if (e.type === "text") {
          t.text += e.delta;
          update();
        } else if (e.type === "break") {
          if (t.text && !t.text.endsWith("\n\n")) t.text += "\n\n";
          update();
        } else if (e.type === "found") {
          const prev = t.groups.find((x) => x.group === e.group);
          // While searching, accumulate finds; when the scout is done, show its shortlist.
          const cards: Card[] = e.done
            ? e.cards.length ? e.cards : prev?.cards.slice(0, 3) ?? []
            : [...(prev?.cards ?? []), ...e.cards.filter((c: Card) => !prev?.cards.some((p) => p.pid === c.pid))].slice(0, 8);
          const next = { group: e.group, cards, done: e.done };
          t.groups = prev ? t.groups.map((x) => (x.group === e.group ? next : x)) : [...t.groups, next];
          update();
        } else if (e.type === "error") throw new Error(e.error);
        else if (e.type === "done") {
          reply = e.entry.text;
          if (!me.detached) setEntries((en) => [...en, { ...e.entry, steps: t.steps, groups: t.groups }]);
          else if (id) cache.current.delete(id);
          ev.current.onCart(e.cartCount ?? 0);
        }
      });
      if (id) ev.current.onTouched(id);
      if (reply === null && !me.detached) {
        // The server finishes the turn even if the connection drops; pick up the saved answer.
        for (let i = 0; i < 30 && reply === null && id; i++) {
          await new Promise((res) => setTimeout(res, 2500));
          if (me.ctrl.signal.aborted) throw new DOMException("Stopped", "AbortError");
          const d = await fetch(`/api/assistant?chat=${encodeURIComponent(id)}`).then((x) => x.json()).catch(() => null);
          const n = d?.entries?.length ?? 0;
          if (n >= 2 && d.entries[n - 1].role === "assistant" && d.entries[n - 2].text === msg) {
            reply = d.entries[n - 1].text;
            setEntries(d.entries);
          }
        }
        if (reply === null) throw new Error("The connection dropped before the answer arrived.");
      }
    } catch (e) {
      if (me.detached) return null;
      if (me.ctrl.signal.aborted) {
        // Keep what was written so far, like stopping a reply in ChatGPT.
        setEntries((en) => [...en, { role: "assistant", text: t.text, cards: [], added: [], steps: t.steps, groups: t.groups, stopped: true }]);
      } else {
        setError({ message: e instanceof Error ? e.message : "Something went wrong.", retryIndex: userIndex, limit: (e as { limit?: { subscriber: boolean; signedIn: boolean } }).limit });
      }
    } finally {
      if (run.current === me) run.current = null;
      if (!me.detached) setTurn(null);
    }
    return reply;
  }

  function regenerate(userIndex: number) {
    const u = entries[userIndex];
    if (u?.role !== "user") return;
    setError(null);
    send(u.text, { editIndex: userIndex, images: u.images ?? [] });
  }

  async function addFiles(list: FileList | File[]) {
    const files = [...list].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    if (!files.length) return flash("Only photos can be attached");
    const room = 4 - attachments.length;
    if (room <= 0) return flash("Up to 4 photos per message");
    if (files.length > room) flash("Up to 4 photos per message");
    for (const f of files.slice(0, room)) {
      const key = Math.random().toString(36).slice(2);
      setAttachments((a) => [...a, { key, preview: URL.createObjectURL(f) }]);
      uploadImage(f)
        .then((id) => setAttachments((a) => a.map((x) => (x.key === key ? { ...x, id } : x))))
        .catch((e) => setAttachments((a) => a.map((x) => (x.key === key ? { ...x, error: e instanceof Error ? e.message : "Upload failed" } : x))));
    }
    inputRef.current?.focus();
  }

  function removeAttachment(key: string) {
    setAttachments((a) => {
      const gone = a.find((x) => x.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return a.filter((x) => x.key !== key);
    });
  }

  function toggleDictation() {
    if (rec.current) return rec.current.stop();
    stopSpeaking();
    const base = input ? input.replace(/\s*$/, " ") : "";
    const r = listen({
      continuous: true,
      onText: (t) => setInput(base + t),
      onEnd: (_final, err) => {
        rec.current = null;
        setDictating(false);
        if (err === "not-allowed" || err === "service-not-allowed") flash("Allow microphone access to use voice");
        inputRef.current?.focus();
      },
    });
    if (!r) return flash("Voice input isn’t available in this browser");
    rec.current = r;
    setDictating(true);
  }

  function readAloud(i: number, text: string) {
    if (speakingIdx === i) {
      stopSpeaking();
      return setSpeakingIdx(null);
    }
    setSpeakingIdx(i);
    speak(text).then(() => setSpeakingIdx((s) => (s === i ? null : s)));
  }

  // Optimistic: the button, badge and toast update on tap; the server's answer confirms or rolls back.
  async function quickAdd(card: Card, variantId?: string) {
    if (adding[card.pid]) return;
    const pick = picking[card.pid];
    setAdding((a) => ({ ...a, [card.pid]: true }));
    setAddedPids((a) => ({ ...a, [card.pid]: true }));
    setPicking((p) => {
      const n = { ...p };
      delete n[card.pid];
      return n;
    });
    pendingAdds.current++;
    setCart(cartRef.current + 1);
    flash("Added to cart", true);
    const undo = (message: string) => {
      setAddedPids((a) => ({ ...a, [card.pid]: false }));
      if (pick) setPicking((p) => ({ ...p, [card.pid]: pick }));
      flash(message);
    };
    let serverCount: number | undefined;
    let ok = false;
    try {
      const r = await fetch("/api/assistant/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(variantId ? { variantId } : { pid: card.pid }),
      });
      const d = await r.json().catch(() => ({}));
      if (typeof d.cartCount === "number") serverCount = d.cartCount;
      if (d.personalize) {
        // Made with the shopper's own photo or text: open the designer instead of adding.
        setAddedPids((a) => ({ ...a, [card.pid]: false }));
        setDesigning({ pid: card.pid, designer: d.personalize });
        setToast(null);
      } else if (d.choose) {
        setAddedPids((a) => ({ ...a, [card.pid]: false }));
        setPicking((p) => ({ ...p, [card.pid]: { options: d.options, selected: d.options.find((o: Option) => o.available)?.id ?? d.options[0]?.id } }));
        flash("Pick an option, then tap Add");
      } else if (d.ok) ok = true;
      else undo(d.message ?? "Couldn’t add that");
    } catch {
      undo("Couldn’t add that. Please try again.");
    } finally {
      pendingAdds.current--;
      // The server's count plus any other taps still on their way; a failure without a count takes ours back.
      if (serverCount !== undefined) setCart(serverCount + pendingAdds.current);
      else if (!ok) setCart(Math.max(0, cartRef.current - 1));
      setAdding((a) => ({ ...a, [card.pid]: false }));
    }
  }

  async function addKit(kit: Kit) {
    setKitState((k) => ({ ...k, [kit.id]: { busy: true, done: 0, total: kit.items.length } }));
    try {
      const r = await fetch("/api/assistant/kit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kitId: kit.id, chatId: activeId.current }) });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Couldn’t add the kit.");
      }
      await readNdjson(r, (e) => {
        if (e.type === "item") setKitState((k) => ({ ...k, [kit.id]: { ...k[kit.id], done: e.done, total: e.total } }));
        else if (e.type === "done") {
          setKitState((k) => ({ ...k, [kit.id]: { busy: false, done: e.results.length, total: e.results.length, results: e.results } }));
          ev.current.onCart(e.cartCount ?? 0);
          const ok = e.results.filter((x: { ok: boolean }) => x.ok).length;
          flash(`Added ${ok} of ${e.results.length} items`, ok > 0);
        } else if (e.type === "error") throw new Error(e.error);
      });
    } catch (e) {
      setKitState((k) => ({ ...k, [kit.id]: { busy: false, done: 0, total: kit.items.length, error: e instanceof Error ? e.message : "Couldn’t add the kit." } }));
    }
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

  const lastUserIndex = entries.map((e) => e.role).lastIndexOf("user");
  const canSend = (!!input.trim() || ready.length > 0) && !uploading && configured;
  const showVoiceButton = canListen && !input.trim() && !attachments.length && !busy;

  const composer = (
    <form
      className={`cx-composer${busy ? " is-busy" : ""}${dictating ? " is-dictating" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        send(input);
      }}
    >
      {attachments.length > 0 && (
        <div className="cx-attach-row">
          {attachments.map((a) => (
            <div key={a.key} className={`cx-attach${a.error ? " is-error" : ""}`} title={a.error}>
              <img src={a.preview} alt="" />
              {!a.id && !a.error && (
                <span className="cx-attach-busy">
                  <Spinner />
                </span>
              )}
              {a.error && <span className="cx-attach-err">!</span>}
              <button type="button" className="cx-attach-x" onClick={() => removeAttachment(a.key)} aria-label="Remove photo">
                <XIcon size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <label className="sr-only" htmlFor="cx-q">
        Message the assistant
      </label>
      <textarea
        id="cx-q"
        ref={inputRef}
        rows={1}
        maxLength={1000}
        value={input}
        enterKeyHint="send"
        placeholder={dictating ? "Listening…" : entries.length ? "Reply…" : "Describe your project, or attach a photo…"}
        onChange={(e) => setInput(e.target.value)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send(input);
          }
        }}
        disabled={!configured}
      />
      <div className="cx-composer-bar">
        <div className="cx-tools">
          <button type="button" className="cx-tool" onClick={() => fileRef.current?.click()} aria-label="Attach photos" title="Attach photos" disabled={!configured}>
            <ClipIcon />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {canListen && (
            <button type="button" className={`cx-tool${dictating ? " is-on" : ""}`} onClick={toggleDictation} aria-label={dictating ? "Stop dictation" : "Dictate"} title={dictating ? "Stop dictation" : "Dictate"} disabled={!configured}>
              <MicIcon />
              {dictating && <span className="cx-rec-dot" aria-hidden />}
            </button>
          )}
        </div>
        <span className="cx-hint">{busy ? "Esc to stop" : dictating ? "Tap the mic to finish" : "Enter to send · Shift+Enter for a new line"}</span>
        {busy ? (
          <button type="button" className="cx-send cx-stop" onClick={() => run.current?.ctrl.abort()} aria-label="Stop">
            <StopIcon />
          </button>
        ) : showVoiceButton ? (
          <button
            type="button"
            className="cx-send cx-voice"
            onClick={() => {
              unlockSpeech();
              setVoiceMode(true);
            }}
            aria-label="Voice mode"
            title="Voice mode"
            disabled={!configured}
          >
            <WaveIcon />
          </button>
        ) : (
          <button type="submit" className="cx-send" disabled={!canSend} aria-label="Send">
            <ArrowUp />
          </button>
        )}
      </div>
    </form>
  );

  return (
    <div
      className={`cx${empty ? " cx-is-empty" : ""}`}
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      <div className="cx-scroll" ref={scrollRef} onScroll={onScroll}>
        {empty ? (
          <div className="cx-empty">
            <div className="cx-hello">
              <h1>What are you building?</h1>
              <p>Describe a project or snap a photo of a part. I’ll find everything from Chinese factories and fill your cart, with shipping to Canada shown before you pay.</p>
            </div>
            {composer}
            {!configured && (
              <p className="cx-err">
                The assistant is switched off right now. You can still <Link href="/search">search the catalog</Link>.
              </p>
            )}
            <div className="cx-examples">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" className="cx-example" onClick={() => send(x)} disabled={!configured}>
                  {x}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="cx-col" aria-live="polite">
            {loading && entries.length === 0 && (
              <div className="cx-loading">
                <Spinner />
              </div>
            )}
            {entries.map((e, i) =>
              e.role === "user" ? (
                <div key={i} className="cx-msg cx-user">
                  {editing?.index === i ? (
                    <form
                      className="cx-edit"
                      onSubmit={(ev2) => {
                        ev2.preventDefault();
                        if (editing.text.trim()) send(editing.text, { editIndex: i, images: e.images ?? [] });
                      }}
                    >
                      <textarea
                        autoFocus
                        value={editing.text}
                        maxLength={1000}
                        onChange={(ev2) => setEditing({ index: i, text: ev2.target.value })}
                        onKeyDown={(ev2) => {
                          if (ev2.key === "Escape") setEditing(null);
                          if (ev2.key === "Enter" && !ev2.shiftKey && !ev2.nativeEvent.isComposing) {
                            ev2.preventDefault();
                            if (editing.text.trim()) send(editing.text, { editIndex: i, images: e.images ?? [] });
                          }
                        }}
                      />
                      <div className="cx-edit-bar">
                        <button type="button" className="cx-btn" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                        <button type="submit" className="cx-btn cx-btn-primary" disabled={!editing.text.trim() || busy}>
                          Send
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="cx-user-col">
                      {e.images && e.images.length > 0 && (
                        <div className="cx-user-imgs">
                          {e.images.map((id) => (
                            <button key={id} type="button" className="cx-user-img" onClick={() => setLightbox(id)} aria-label="View photo">
                              <img src={imageUrl(id)} alt="" loading="lazy" />
                            </button>
                          ))}
                        </div>
                      )}
                      {e.text && <div className="cx-bubble">{e.text}</div>}
                      {!busy && e.text && (
                        <div className="cx-actions cx-actions-user">
                          <button type="button" className="cx-icon-btn" onClick={() => copy(i, e.text)} aria-label="Copy message" title="Copy">
                            {copied === i ? <span className="cx-check">✓</span> : <CopyIcon />}
                          </button>
                          <button type="button" className="cx-icon-btn" onClick={() => setEditing({ index: i, text: e.text })} aria-label="Edit message" title="Edit">
                            <PencilIcon />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div key={i} className="cx-msg cx-bot">
                  <Logo />
                  <div className="cx-bot-body">
                    {e.steps && <Steps steps={e.steps} groups={e.groups ?? []} live={false} />}
                    {e.text ? <Markdown text={e.text} /> : e.stopped ? null : <p className="cx-muted">No reply.</p>}
                    {e.stopped && <p className="cx-stopped">You stopped this answer.</p>}
                    {e.added.length > 0 && (
                      <div className="cx-added">
                        {e.added.map((a) => (
                          <div key={a}>
                            <span className="cx-check" aria-hidden>
                              ✓
                            </span>{" "}
                            Added {a}
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
                      {canSpeak && e.text && (
                        <button type="button" className={`cx-icon-btn${speakingIdx === i ? " is-on" : ""}`} onClick={() => readAloud(i, e.text)} aria-label={speakingIdx === i ? "Stop reading" : "Read aloud"} title={speakingIdx === i ? "Stop" : "Read aloud"}>
                          {speakingIdx === i ? <StopIcon /> : <SpeakerIcon />}
                        </button>
                      )}
                      {i === entries.length - 1 && lastUserIndex === i - 1 && !busy && (
                        <button type="button" className="cx-icon-btn" onClick={() => regenerate(lastUserIndex)} aria-label="Regenerate" title="Regenerate">
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
                {error.limit ? (
                  <span className="cx-error-actions">
                    {!error.limit.subscriber && (
                      <Link href="/plans" className="cx-btn cx-btn-primary">
                        Subscribe
                      </Link>
                    )}
                    {!error.limit.signedIn && (
                      <Link href={`/account?next=${encodeURIComponent(activeId.current ? `/c/${activeId.current}` : "/")}`} className="cx-btn">
                        Sign in
                      </Link>
                    )}
                  </span>
                ) : (
                  <button type="button" className="cx-btn" onClick={() => regenerate(error.retryIndex)}>
                    <RetryIcon /> Try again
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {!empty && (
        <div className="cx-dock">
          {!atBottom && (
            <button type="button" className="cx-jump" onClick={() => scrollToEnd(true)} aria-label="Jump to latest">
              <DownIcon />
            </button>
          )}
          {composer}
          <p className="cx-disclaimer">
            The assistant can make mistakes. Check specs before you order.{" "}
            {allowance && (
              <Link href="/account">
                {allowance.remaining} {allowance.subscriber ? "" : "free "}AI message{allowance.remaining === 1 ? "" : "s"} left
              </Link>
            )}{" "}
            {cartCount > 0 && <Link href="/cart">Cart ({cartCount})</Link>}
          </p>
        </div>
      )}

      {dragging && (
        <div className="cx-drop" aria-hidden>
          <div>Drop photos to attach</div>
        </div>
      )}

      {lightbox && (
        <div className="cx-lightbox" role="dialog" aria-label="Photo" onClick={() => setLightbox(null)}>
          <img src={imageUrl(lightbox)} alt="" />
          <button type="button" className="cx-lightbox-x" aria-label="Close">
            <XIcon size={20} />
          </button>
        </div>
      )}

      {voiceMode && <VoiceMode onSend={(text) => send(text, { voice: true, images: [] })} onClose={() => setVoiceMode(false)} />}

      {designing && (
        <DesignModal
          designer={designing.designer}
          photos={[...new Set(entries.flatMap((e) => (e.role === "user" ? (e.images ?? []) : [])))].slice(-8).reverse().map(imageUrl)}
          onClose={() => setDesigning(null)}
          onAdded={(r) => {
            if (!r.ok) return;
            if (typeof r.cartCount === "number") setCart(r.cartCount);
            setAddedPids((a) => ({ ...a, [designing.pid]: true }));
            setDesigning(null);
            flash("Personalized item added to cart", true);
          }}
        />
      )}
      {toast && (
        <div className="cx-toast" role="status">
          {toast.text}
          {toast.cart && <Link href="/cart">View cart</Link>}
        </div>
      )}
    </div>
  );
}
