"use client";
// One conversation with the sourcing assistant, laid out like iMessage (blue and gray bubbles, tapbacks, typing
// dots, read receipts) because everyone already knows how to read it: streamed answers, photos, voice, edit, regenerate.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import DesignModal from "./DesignModal";
import AgentBlob from "./AgentBlob";
import { LiveTrace, SavedTrace } from "./AgentTrace";
import ShareButton from "@/components/ShareButton";
import PlanPicker from "@/components/PlanPicker";
import type { PlanOffer } from "@/lib/plan-offer";
import type { ChatDesigner } from "@/lib/personalize";
import {
  ArrowUp,
  CopyIcon,
  DownIcon,
  EXAMPLES,
  HOTEL_EMAIL_TEST,
  KitCard,
  Markdown,
  MicIcon,
  PencilIcon,
  PlusIcon2,
  ProductCard,
  ConnectorCards,
  RetryIcon,
  SpeakerIcon,
  Spinner,
  Steps,
  StopIcon,
  WaveIcon,
  XIcon,
  costLine,
  groupCards,
  readNdjson,
  showStamp,
  stampLabel,
  type Card,
  type Entry,
  type KitState,
  type Kit,
  type Option,
  type Turn,
} from "./ui";
import { imageUrl, uploadImage } from "./images";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import type { ConnectorItem } from "@/lib/flights-shared";
import { MAX_DOCS, MAX_PDF_B64, PASTE_AS_DOC_CHARS, TEXT_FILE, docInfo, docLabel, type DocUpload } from "@/lib/docs-shared";
import { listen, speak, speechInputSupported, speechOutputSupported, stopSpeaking, unlockSpeech, type Recognizer } from "./voice";
import VoiceMode from "./VoiceMode";
import { RunContext, type ApprovalUi, type BrowserRunContext } from "./run-context";
import { cancelRun, createRun, foldRun, newClientRequestId, resumeRun, subscribeRun, type RunConnection, type RunSubscription } from "@/lib/run-client";
import type { ApprovalRecord, PendingStep, ResumeResult, RunFrame, RunSnapshot } from "@/lib/run-shared";

interface Attachment {
  key: string;
  preview: string;
  id?: string;
  error?: string;
}

/** A long paste or a text/PDF file waiting to be sent as a document. */
type PendingDoc = DocUpload & { key: string };

function readBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
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

export default function Chat({
  chatId,
  configured,
  cartCount,
  events,
  storeName = "Assistant",
  initials = "AI",
}: {
  chatId: string | null;
  configured: boolean;
  cartCount: number;
  events: ChatEvents;
  storeName?: string;
  initials?: string;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(chatId !== null);
  const [input, setInput] = useState("");
  const [turn, setTurn] = useState<Turn | null>(null);
  // Neon's little reactions: a nod per keystroke or burst of words, a hop when something lands in the cart.
  const [nudge, setNudge] = useState(0);
  const [cheer, setCheer] = useState(0);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<{ message: string; retryIndex: number; limit?: { subscriber: boolean; signedIn: boolean } } | null>(null);
  const [allowance, setAllowance] = useState<{ remaining: number; limit: number; subscriber: boolean } | null>(null);
  // The plans offered to this shopper (null for subscribers), and whether the plan sheet is open.
  const [plans, setPlans] = useState<PlanOffer | null>(null);
  const [showPlans, setShowPlans] = useState(false);
  const [toast, setToast] = useState<{ text: string; cart?: boolean } | null>(null);
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  const [addedPids, setAddedPids] = useState<Record<string, boolean>>({});
  const [kitState, setKitState] = useState<Record<string, KitState>>({});
  const [picking, setPicking] = useState<Record<string, { options: Option[]; selected?: string }>>({});
  const [designing, setDesigning] = useState<{ pid: string; designer: ChatDesigner } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [docs, setDocs] = useState<PendingDoc[]>([]);
  const [addMenu, setAddMenu] = useState(false);
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
  // The run answering in this chat (server-owned; this page just follows it). Null when nothing is running.
  const run = useRef<{ id: string; chatId: string; snap: RunSnapshot; sub: RunSubscription | null; resolve: (reply: string | null) => void } | null>(null);
  const stopWhenAccepted = useRef(false);
  const approving = useRef(new Map<string, Promise<ResumeResult>>());
  const [approvalUi, setApprovalUi] = useState<Record<string, ApprovalUi>>({});
  // The pending approval's message in the chat, and whether it's on screen (else the bar above the composer shows it).
  const approvalRef = useRef<HTMLDivElement | null>(null);
  const [approvalVisible, setApprovalVisible] = useState(true);
  const [live, setLive] = useState<RunSnapshot | null>(null);
  const [runConn, setRunConn] = useState<RunConnection | null>(null);
  const activeId = useRef<string | null | undefined>(undefined);
  const cache = useRef(new Map<string, Entry[]>());
  const stick = useRef(true);
  const rec = useRef<Recognizer | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragDepth = useRef(0);
  const ev = useRef(events);
  const cartRef = useRef(cartCount);
  cartRef.current = cartCount;
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
    // Leave a running answer to finish on the server; it'll be there (and followed again) when this chat is reopened.
    detach();
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
      // Whether this shopper is on the free preview (and the plans to offer when it runs out).
      fetch("/api/assistant")
        .then((r) => r.json())
        .then((d) => {
          if (d.allowance) setAllowance(d.allowance);
          setPlans(d.plans ?? null);
        })
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
        // A reply still being written (e.g. after a refresh, or while Neon waits on the shopper): follow it again.
        const active = d.activeRun as RunSnapshot | null;
        if (active && !(d.entries ?? []).some((e: Entry) => e.role === "assistant" && e.id === active.id)) follow(active, chatId);
        else showLastRunError(d.lastRun as RunSnapshot | null, d.entries ?? []);
        ev.current.onCart(d.cartCount ?? 0);
        if (d.allowance) setAllowance(d.allowance);
        setPlans(d.plans ?? null);
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

  // Leaving the chat page: stop following the run (it carries on on the server).
  useEffect(() => () => detach(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Is the pending approval's message on screen? If not, the bar above the composer offers the same action
  // (the chat is never scrolled for the shopper while they read older messages).
  const pendingId = live?.pending?.id ?? null;
  useEffect(() => {
    const el = approvalRef.current;
    const root = scrollRef.current;
    if (!pendingId || !el || !root) return setApprovalVisible(true);
    const io = new IntersectionObserver(([e]) => setApprovalVisible(e.isIntersecting), { root, threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [pendingId, turn !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc stops a running answer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && run.current && !voiceMode && !document.querySelector(".cx-browser.is-full")) stop();
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

  /** The live reply as the chat renders it (the run's partial reply, folded from its frames). */
  const toTurn = (snap: RunSnapshot): Turn => ({
    text: snap.partial.text,
    steps: snap.partial.steps,
    groups: snap.partial.groups,
    items: snap.partial.items,
    trace: snap.partial.trace,
    started: Date.parse(snap.startedAt ?? snap.createdAt) || Date.now(),
    chars: snap.partial.chars,
  });

  /** Stops following the current run on this page (the run itself carries on on the server). */
  function detach() {
    const r = run.current;
    run.current = null;
    if (!r) return;
    r.sub?.close();
    r.resolve(null);
    setLive(null);
    setRunConn(null);
  }

  /** Reloads the transcript (after a run stopped, failed or was interrupted: the server saved what happened). */
  async function reconcile(cid: string) {
    const d = await fetch(`/api/assistant?chat=${encodeURIComponent(cid)}`, { cache: "no-store" })
      .then((x) => x.json())
      .catch(() => null);
    if (!d?.chat || activeId.current !== cid) return null;
    setEntries(d.entries ?? []);
    if (d.allowance) setAllowance(d.allowance);
    return d as { entries: Entry[]; lastRun: RunSnapshot | null };
  }

  function showLastRunError(last: RunSnapshot | null, list: Entry[]) {
    if (!last || (last.status !== "failed" && last.status !== "interrupted")) return;
    const u = list[last.userIndex];
    if (u?.role === "user" && u.failed) setError({ message: last.error || "That message didn't go through.", retryIndex: last.userIndex });
  }

  /** Follows a run: renders its reply as it's written, and settles the transcript when it ends. */
  function follow(snap: RunSnapshot, cid: string, resolve: (reply: string | null) => void = () => {}) {
    detach();
    const me = { id: snap.id, chatId: cid, snap, sub: null as RunSubscription | null, resolve };
    run.current = me;
    stick.current = true;
    setLive(snap);
    setTurn(toTurn(snap));
    if (snap.partial.reaction) patchUserAt(snap.userIndex, { reaction: snap.partial.reaction });
    const finish = async (status: string) => {
      if (run.current !== me) return;
      run.current = null;
      me.sub?.close();
      setLive(null);
      setRunConn(null);
      const d = await reconcile(cid);
      me.resolve(null);
      // The shopper may have opened another chat meanwhile: nothing here belongs on its screen.
      if (activeId.current !== cid) return;
      setTurn(null);
      if (status === "failed" || status === "interrupted") setError({ message: me.snap.error || "Something went wrong.", retryIndex: me.snap.userIndex });
      else if (!d) setError({ message: "The connection dropped before the answer arrived.", retryIndex: me.snap.userIndex });
    };
    const onFrame = (f: RunFrame) => {
      if (run.current !== me) return;
      if (f.type === "title") ev.current.onTitle(f.chatId, f.title);
      if (f.type === "event" && (f.event.type === "text" || f.event.type === "thinking")) setNudge((x) => x + 1);
      if (f.type === "event" && f.event.type === "react") patchUserAt(me.snap.userIndex, { reaction: f.event.emoji });
      if (f.type === "done") {
        const { entry, reaction, cartCount: count, allowance: after } = f.done;
        run.current = null;
        me.sub?.close();
        const steps = me.snap.partial.steps;
        const groups = me.snap.partial.groups;
        setEntries((en) => {
          const kept = en.filter((x) => !(x.role === "assistant" && x.id === entry.id));
          const at = Math.min(me.snap.userIndex + 1, kept.length);
          return [...kept.slice(0, at), { ...(entry as unknown as Entry), steps, groups } as Entry, ...kept.slice(at)];
        });
        if (reaction) patchUserAt(me.snap.userIndex, { reaction });
        if (after) setAllowance(after);
        if (Array.isArray(entry.added) && entry.added.length) setCheer((c) => c + 1);
        else cache.current.delete(cid);
        if (count >= 0) setCart(count);
        ev.current.onTouched(cid);
        setTurn(null);
        setLive(null);
        setRunConn(null);
        me.resolve(entry.text);
        return;
      }
      me.snap = foldRun(me.snap, f);
      setLive(me.snap);
      setTurn(toTurn(me.snap));
      if (f.type === "status" && !["queued", "running", "waiting", "completed"].includes(f.status)) void finish(f.status);
      if (f.type === "snapshot" && ["failed", "cancelled", "interrupted"].includes(f.run.status)) void finish(f.run.status);
    };
    me.sub = subscribeRun(snap.id, {
      after: snap.seq,
      onFrame,
      onConnection: (c) => run.current === me && setRunConn(c),
      onEnd: (reason) => {
        if (reason === "not_found" || (run.current === me && !isActiveStatus(me.snap.status))) void finish(me.snap.status);
      },
    });
  }

  /** The assistant's tapback (and the server's timestamp) land on the message just sent. */
  function patchUserAt(index: number, patch: Partial<Entry>) {
    setEntries((en) => en.map((x, k) => (k === index && x.role === "user" ? ({ ...x, ...patch } as Entry) : x)));
  }

  /** Stop: the server stops the run and saves what was written; the stream then ends it here. */
  async function stop() {
    const r = run.current;
    if (!r) {
      // Stop tapped while the message is still being accepted: stop the run as soon as it exists.
      if (turn) stopWhenAccepted.current = true;
      return;
    }
    const res = await cancelRun(r.id);
    if (run.current === r && res && !isActiveStatus(res.run.status)) {
      r.snap = { ...r.snap, status: res.run.status };
      run.current = null;
      r.sub?.close();
      setLive(null);
      setRunConn(null);
      await reconcile(r.chatId);
      r.resolve(null);
      if (activeId.current === r.chatId) setTurn(null);
    }
  }

  /** Resume a step the run is waiting on (the live browser's "Done — continue"). Folds in the server's view. */
  const resume = useCallback(async (stepId: string): Promise<ResumeResult> => {
    const r = run.current;
    if (!r) return { accepted: false, reason: "run_finished", message: "Neon has already finished this.", current: null };
    const res = await resumeRun(r.id, stepId);
    if (run.current === r && res.accepted === false && res.current) {
      r.snap = foldRun(r.snap, { type: "snapshot", seq: res.current.seq, run: res.current });
      setLive(r.snap);
      setTurn(toTurn(r.snap));
    }
    return res;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Approve & next for exactly `stepId` (CONTRACTS.md §12). Repeat taps share the request in flight; the outcome
   * is mirrored in `approvalUi`. "Approved" only after the server accepted this same step.
   */
  const approve = useCallback(
    (stepId: string): Promise<ResumeResult> => {
      const busyNow = approving.current.get(stepId);
      if (busyNow) return busyNow;
      const p = (async () => {
        setApprovalUi((m) => ({ ...m, [stepId]: { phase: "approving" } }));
        const r = await resume(stepId);
        let next: ApprovalUi;
        if (r.accepted && r.stepId === stepId) next = { phase: "approved" };
        else if (r.accepted) next = { phase: "stale", message: "Superseded: Neon needs something else now." };
        else if (r.reason === "not_waiting" && !r.current) next = { phase: "error", message: r.message || "Couldn't reach Neon. Try again." };
        else
          next = {
            phase: "stale",
            message:
              r.reason === "stale_step"
                ? "Superseded: Neon needs something else now."
                : r.reason === "expired"
                  ? "Timed out. Ask Neon to try again."
                  : r.reason === "run_finished"
                    ? "Already finished."
                    : "No longer needed.",
          };
        setApprovalUi((m) => ({ ...m, [stepId]: next }));
        return r;
      })().finally(() => approving.current.delete(stepId));
      approving.current.set(stepId, p);
      return p;
    },
    [resume],
  );

  // Only the reply being written answers a pending step: older replies can show the same browser (one per chat),
  // and must not open it too.
  const runCtx: BrowserRunContext = {
    chatId: activeId.current ?? chatId,
    pending: live?.pending ?? null,
    runStatus: live?.status ?? null,
    resume,
    stop,
    approve,
    approvals: approvalUi,
  };
  const savedCtx: BrowserRunContext = { ...runCtx, pending: null };

  /** Sends one message; resolves with the reply text (for voice mode), or null if it didn't finish. */
  async function send(text: string, opts: { voice?: boolean; editIndex?: number; images?: string[] } = {}): Promise<string | null> {
    const msg = text.trim();
    const images = opts.images ?? ready;
    // Edits and regenerations reuse the documents already in the chat; a new message sends what's attached.
    const sending = opts.images ? [] : docs;
    if ((!msg && !images.length && !sending.length && opts.editIndex == null) || busy || !configured) return null;
    if (!opts.images && uploading) {
      flash("Wait for the photo to finish uploading");
      return null;
    }
    rec.current?.stop();
    stopSpeaking();
    setSpeakingIdx(null);
    let id = activeId.current ?? null;
    const sentFrom = activeId.current;
    stopWhenAccepted.current = false;
    stick.current = true;
    setError(null);
    setEditing(null);
    const draft = { input, attachments, docs };
    if (!opts.images) {
      setInput("");
      setAttachments([]);
      setDocs([]);
    }
    const userIndex = opts.editIndex ?? entries.length;
    const was = opts.editIndex != null ? entries[opts.editIndex] : undefined;
    const keptDocs = was?.role === "user" ? was.docs : undefined;
    const docMeta = sending.length ? sending.map(docInfo) : keptDocs;
    const before = entries;
    setEntries((e) => [...e.slice(0, userIndex), { role: "user", text: msg, ...(images.length ? { images } : {}), ...(docMeta?.length ? { docs: docMeta } : {}), at: new Date().toISOString() }]);
    setTurn({ text: "", steps: [], groups: [], items: [], trace: [], started: Date.now(), chars: 0 });
    const r = await createRun({
      clientRequestId: newClientRequestId(),
      message: msg,
      chatId: id ?? undefined,
      images,
      voice: !!opts.voice,
      editIndex: opts.editIndex,
      ...(sending.length ? { docs: sending.map(({ name, kind, data }) => ({ name, kind, data })) } : {}),
    });
    if (!r.ok) {
      setTurn(null);
      const body = r.body as { limit?: { subscriber: boolean; signedIn: boolean }; plans?: PlanOffer | null; activeRun?: RunSnapshot };
      if (r.status === 409 && body.activeRun && id) {
        // Neon is still answering here (another tab, or a send that already landed): show that instead.
        setEntries(before);
        if (!opts.images) {
          setInput(draft.input);
          setAttachments(draft.attachments);
          setDocs(draft.docs);
        }
        await reconcile(id);
        follow(body.activeRun, id);
        return null;
      }
      if (body.limit) {
        setAllowance((a) => (a ? { ...a, remaining: 0 } : a));
        // Out of messages: offer the plans right here, without leaving the chat.
        if (body.plans) {
          setPlans(body.plans);
          setShowPlans(true);
        }
      }
      // Nothing was sent: put the draft back.
      if (!opts.images && !body.limit) {
        setInput(draft.input);
        setAttachments(draft.attachments);
        setDocs(draft.docs);
        setEntries(before);
      }
      setError({ message: r.error, retryIndex: userIndex, limit: body.limit });
      return null;
    }
    const { run: snap, chat, user } = r.accepted;
    // Another chat is on screen now: the reply carries on on the server and shows when this chat is opened.
    if (activeId.current !== sentFrom) return null;
    if (stopWhenAccepted.current) {
      stopWhenAccepted.current = false;
      void cancelRun(snap.id);
    }
    if (!id) {
      id = chat.id;
      activeId.current = id;
      ev.current.onCreated(id, chat.title);
    }
    // The saved message (with its id) replaces the one shown while sending.
    setEntries((en) => [...en.slice(0, snap.userIndex), user as unknown as Entry, ...en.slice(snap.userIndex + 1)]);
    const cid = id;
    return new Promise<string | null>((resolve) => follow(snap, cid, resolve));
  }

  function regenerate(userIndex: number) {
    const u = entries[userIndex];
    if (u?.role !== "user") return;
    setError(null);
    send(u.text, { editIndex: userIndex, images: u.images ?? [] });
  }

  /**
   * Pastes from the clipboard with one tap (no long-press menu, no giant text in the box): long text becomes
   * a document, short text goes into the message.
   */
  async function pasteFromClipboard() {
    setAddMenu(false);
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return flash("Allow paste when your phone asks, or long-press the message box and paste");
    }
    if (!text.trim()) return flash("Nothing to paste");
    if (text.length > PASTE_AS_DOC_CHARS) addDoc({ name: `Pasted text ${docs.length + 1}`, kind: "text", data: text });
    else {
      setInput((v) => (v ? v.replace(/\s*$/, " ") : "") + text);
      inputRef.current?.focus();
    }
  }

  /** Adds a long paste or a text/PDF file as a document attachment. */
  function addDoc(d: DocUpload) {
    if (docs.length >= MAX_DOCS) return flash(`Up to ${MAX_DOCS} documents per message`);
    if (d.kind === "text" && d.data.length > MAX_MESSAGE_CHARS) return flash(`Documents can be up to ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters`);
    if (d.kind === "pdf" && d.data.length > MAX_PDF_B64) return flash("PDFs can be up to about 20 MB");
    setDocs((x) => [...x, { ...d, key: Math.random().toString(36).slice(2) }]);
    inputRef.current?.focus();
  }

  async function addFiles(list: FileList | File[]) {
    const all = [...list];
    for (const f of all) {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) readBase64(f).then((data) => addDoc({ name: f.name, kind: "pdf", data }), () => flash("That PDF couldn't be read"));
      else if (f.type.startsWith("text/") || f.type === "application/json" || TEXT_FILE.test(f.name)) f.text().then((data) => addDoc({ name: f.name, kind: "text", data }), () => flash("That file couldn't be read"));
    }
    const files = all.filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
    if (!files.length) {
      if (!all.some((f) => f.type === "application/pdf" || f.type.startsWith("text/") || f.type === "application/json" || /\.pdf$/i.test(f.name) || TEXT_FILE.test(f.name))) flash("Attach photos, PDFs or text files");
      return;
    }
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

  // The button spins until the server confirms; the badge, toast and "✓ Added" only show for a real add, so a
  // product that needs an option picked (or is sold out) never looks added when it isn't.
  async function quickAdd(card: Card, variantId?: string) {
    if (adding[card.pid]) return;
    const pick = picking[card.pid];
    setAdding((a) => ({ ...a, [card.pid]: true }));
    try {
      const r = await fetch("/api/assistant/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(variantId ? { variantId } : { pid: card.pid }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.personalize) {
        // Made with the shopper's own photo or text: open the designer instead of adding.
        setDesigning({ pid: card.pid, designer: d.personalize });
      } else if (d.choose) {
        setPicking((p) => ({ ...p, [card.pid]: { options: d.options, selected: d.options.find((o: Option) => o.available)?.id ?? d.options[0]?.id } }));
        flash("Pick an option, then tap Add");
      } else if (d.ok) {
        setAddedPids((a) => ({ ...a, [card.pid]: true }));
        setPicking((p) => {
          const n = { ...p };
          delete n[card.pid];
          return n;
        });
        if (typeof d.cartCount === "number") setCart(d.cartCount);
        flash("Added to cart", true);
        setCheer((c) => c + 1);
      } else {
        if (pick) setPicking((p) => ({ ...p, [card.pid]: pick }));
        flash(d.message ?? "Couldn’t add that");
      }
    } catch {
      flash("Couldn’t add that. Please try again.");
    } finally {
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
          if (e.results.some((x: { ok: boolean }) => x.ok)) setCheer((c) => c + 1);
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
  const canSend = (!!input.trim() || ready.length > 0 || docs.length > 0) && !uploading && configured;
  const showVoiceButton = canListen && !input.trim() && !attachments.length && !docs.length && !busy;

  const composer = (
    <form
      className={`cx-composer${busy ? " is-busy" : ""}${dictating ? " is-dictating" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        send(input);
      }}
    >
      <div className="cx-add">
        <button type="button" className="cx-plus" onClick={() => setAddMenu((v) => !v)} aria-label="Add photos, files or pasted text" aria-expanded={addMenu} aria-haspopup="menu" disabled={!configured}>
          <PlusIcon2 />
        </button>
        {addMenu && (
          <>
            <button type="button" className="cx-add-scrim" aria-label="Close" onClick={() => setAddMenu(false)} />
            <div className="cx-add-menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setAddMenu(false)}>
              <button type="button" role="menuitem" autoFocus onClick={pasteFromClipboard}>
                <span className="cx-add-ic" aria-hidden>
                  ⎘
                </span>
                <span>
                  Paste text
                  <small>Long text is attached as a document</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAddMenu(false);
                  fileRef.current?.click();
                }}
              >
                <span className="cx-add-ic" aria-hidden>
                  ＋
                </span>
                <span>
                  Photos or files
                  <small>Photos, PDFs, text and CSV files</small>
                </span>
              </button>
            </div>
          </>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf,.pdf,text/plain,.txt,.md,.csv,.tsv,.json"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="cx-pill">
        {(attachments.length > 0 || docs.length > 0) && (
          <div className="cx-attach-row">
            {docs.map((d) => (
              <div key={d.key} className="cx-doc">
                <span className="cx-doc-icon" aria-hidden>
                  {d.kind === "pdf" ? "PDF" : "TXT"}
                </span>
                <span className="cx-doc-text">
                  <span className="cx-doc-name">{d.name}</span>
                  <span className="cx-doc-size">{docLabel(docInfo(d))}</span>
                </span>
                <button type="button" className="cx-attach-x" onClick={() => setDocs((x) => x.filter((y) => y.key !== d.key))} aria-label={`Remove ${d.name}`}>
                  <XIcon size={12} />
                </button>
              </div>
            ))}
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
        <div className="cx-pill-row">
          <label className="sr-only" htmlFor="cx-q">
            Message the assistant
          </label>
          <textarea
            id="cx-q"
            ref={inputRef}
            rows={1}
            maxLength={MAX_MESSAGE_CHARS}
            value={input}
            enterKeyHint="send"
            placeholder={dictating ? "Listening…" : "Message"}
            onChange={(e) => {
              setInput(e.target.value);
              setNudge((n) => n + 1);
            }}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
              if (files.length) {
                e.preventDefault();
                addFiles(files);
                return;
              }
              // A long paste becomes a document Neon reads in full, instead of flooding the message box.
              const pasted = e.clipboardData.getData("text/plain");
              if (pasted.length > PASTE_AS_DOC_CHARS) {
                e.preventDefault();
                addDoc({ name: `Pasted text ${docs.length + 1}`, kind: "text", data: pasted });
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
          {busy ? (
            <button type="button" className="cx-send cx-stop" onClick={() => void stop()} aria-label="Stop" title="Stop (Esc)">
              <StopIcon />
            </button>
          ) : canSend ? (
            <button type="submit" className="cx-send" aria-label="Send">
              <ArrowUp />
            </button>
          ) : canListen ? (
            <button type="button" className={`cx-mic${dictating ? " is-on" : ""}`} onClick={toggleDictation} aria-label={dictating ? "Stop dictation" : "Dictate"} title={dictating ? "Stop dictation" : "Dictate"} disabled={!configured}>
              <MicIcon />
              {dictating && <span className="cx-rec-dot" aria-hidden />}
            </button>
          ) : (
            <button type="submit" className="cx-send" disabled aria-label="Send">
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
      {showVoiceButton && (
        <button
          type="button"
          className="cx-voice-btn"
          onClick={() => {
            unlockSpeech();
            setVoiceMode(true);
          }}
          aria-label="Talk to the assistant"
          title="Talk to the assistant"
          disabled={!configured}
        >
          <WaveIcon />
        </button>
      )}
    </form>
  );

  /** The status under the message just sent, like iMessage: Delivered, then Read once the assistant reacts or answers. */
  const receipt = (i: number) => {
    const e = entries[i];
    if (!busy || i !== entries.length - 1 || e.role !== "user") return null;
    return <div className="cx-receipt">{e.reaction || turn?.text || (turn?.steps.length ?? 0) > 1 ? "Read" : "Delivered"}</div>;
  };

  const stamp = (i: number) => {
    const at = showStamp(entries, i);
    return at ? <div className="cx-stamp">{stampLabel(at)}</div> : null;
  };

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
            <div className="cx-contact">
              <AgentBlob size={76} className="cx-avatar cx-avatar-lg" attentive={typing && !!input.trim()} nudge={typing ? nudge : 0} />
              <h1>{storeName}</h1>
              <p>Your personal POS · replies in seconds</p>
              <ShareButton className="cx-share share-center" url="/" text={`${storeName}: your own personal POS system in a chat`} label={`Share ${storeName}`} />
            </div>
            <div className="cx-col cx-greeting" aria-label="How it works">
              <div className="cx-msg cx-bot">
                <div className="cx-bubble cx-bubble-bot cx-no-tail">Hey! 👋 I’m Neon, your personal POS. Tell me what you need, parts, supplies or a flight, like you’d text a friend.</div>
              </div>
              <div className="cx-msg cx-bot">
                <div className="cx-bubble cx-bubble-bot cx-no-tail">I’ll find it, compare the best options and check you out right here. You see the full price before you pay.</div>
              </div>
              <div className="cx-msg cx-bot">
                <div className="cx-bubble cx-bubble-bot">Type, talk 🎙️ or send a photo 📷. Or tap one of these:</div>
              </div>
              {!configured && (
                <p className="cx-err">
                  The assistant is switched off right now. You can still <Link href="/search">search the catalog</Link>.
                </p>
              )}
              <div className="cx-examples" role="group" aria-label="Suggestions">
                {EXAMPLES.map((x) => (
                  <button key={x} type="button" className="cx-example" onClick={() => send(x)} disabled={!configured}>
                    {x}
                  </button>
                ))}
                <button type="button" className="cx-example cx-example-test" onClick={() => send(HOTEL_EMAIL_TEST.prompt)} disabled={!configured}>
                  {HOTEL_EMAIL_TEST.label}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <RunContext.Provider value={savedCtx}>
          <div className="cx-col" aria-live="polite">
            {loading && entries.length === 0 && (
              <div className="cx-loading">
                <Spinner />
              </div>
            )}
            {entries.map((e, i) =>
              e.role === "user" ? (
                <div key={i} className="cx-msg cx-user">
                  {stamp(i)}
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
                        maxLength={MAX_MESSAGE_CHARS}
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
                    <div className={`cx-user-col${e.reaction ? " has-tapback" : ""}`}>
                      {e.reaction && (
                        <span className="cx-tapback" role="img" aria-label={`The assistant reacted ${e.reaction}`} key={e.reaction}>
                          {e.reaction}
                        </span>
                      )}
                      {e.images && e.images.length > 0 && (
                        <div className="cx-user-imgs">
                          {e.images.map((id) => (
                            <button key={id} type="button" className="cx-user-img" onClick={() => setLightbox(id)} aria-label="View photo">
                              <img src={imageUrl(id)} alt="" loading="lazy" />
                            </button>
                          ))}
                        </div>
                      )}
                      {e.docs && e.docs.length > 0 && (
                        <div className="cx-user-docs">
                          {e.docs.map((d, k) => (
                            <div key={k} className="cx-doc is-sent">
                              <span className="cx-doc-icon" aria-hidden>
                                {d.kind === "pdf" ? "PDF" : "TXT"}
                              </span>
                              <span className="cx-doc-text">
                                <span className="cx-doc-name">{d.name}</span>
                                <span className="cx-doc-size">{docLabel(d)}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {e.text && <UserText text={e.text} />}
                      {e.failed && (
                        <div className="cx-failed">
                          Not delivered ·{" "}
                          <button type="button" className="cx-failed-retry" onClick={() => regenerate(i)} disabled={busy}>
                            Retry
                          </button>
                        </div>
                      )}
                      {receipt(i)}
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
                  {stamp(i)}
                  <div className="cx-bot-body">
                    <SavedTrace trace={e.trace} ms={e.thoughtMs} />
                    {(e.groups?.length ?? 0) > 0 && <Steps steps={e.steps ?? []} groups={e.groups ?? []} live={false} />}
                    {e.text ? (
                      <div className="cx-bubble cx-bubble-bot">
                        <Markdown text={e.text} />
                      </div>
                    ) : e.stopped ? null : (
                      <div className="cx-bubble cx-bubble-bot cx-muted">No reply.</div>
                    )}
                    {e.stopped && <p className="cx-stopped">You stopped this answer.</p>}
                    {e.approvals && e.approvals.length > 0 && <ApprovalLog records={e.approvals} />}
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
                    {e.items && <ConnectorCards items={e.items} />}
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
                    <div className="cx-foot">
                      {i === entries.length - 1 && !busy && (
                        <AgentBlob size={26} className="cx-agent-mark" label="Neon" attentive={typing && !!input.trim()} nudge={typing ? nudge : 0} cheer={cheer} />
                      )}
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
                    {e.cost && <div className="cx-cost">{costLine(e.cost)}</div>}
                  </div>
                </div>
              ),
            )}

            {turn && (
              <RunContext.Provider value={runCtx}>
              <div className="cx-msg cx-bot">
                <div className="cx-bot-body">
                  <LiveTrace trace={turn.trace} started={turn.started} chars={turn.chars} writing={!!turn.text} nudge={nudge} helpers={helpersAt(turn)} />
                  {turn.groups.length > 0 && <Steps steps={turn.steps} groups={turn.groups} live />}
                  <ConnectorCards items={turn.items} />
                  {turn.text && (
                    <div className="cx-bubble cx-bubble-bot cx-streaming">
                      <Markdown text={turn.text} />
                    </div>
                  )}
                  {turn.text && (
                    <div className="cx-agent">
                      <AgentBlob size={26} mood="thinking" label="Neon is writing" nudge={nudge} />
                    </div>
                  )}
                </div>
              </div>
              </RunContext.Provider>
            )}

            {live && (
              <RunContext.Provider value={runCtx}>
                <Approvals records={live.partial.approvals ?? []} pending={live.pending} ui={approvalUi} onApprove={approve} activeRef={approvalRef} />
              </RunContext.Provider>
            )}

            {runConn === "reconnecting" && <div className="cx-run-conn">Reconnecting…</div>}
            {runConn === "offline" && (
              <button type="button" className="cx-run-conn is-offline" onClick={() => run.current?.sub?.reconnect()}>
                Connection lost. Tap to reconnect.
              </button>
            )}

            {error && (
              <div className="cx-error" role="alert">
                <span>{error.message}</span>
                {error.limit ? (
                  <span className="cx-error-actions">
                    {plans && (
                      <button type="button" className="cx-btn cx-btn-primary" onClick={() => setShowPlans(true)}>
                        See plans
                      </button>
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
          </RunContext.Provider>
        )}
      </div>

      <div className="cx-dock">
        {!atBottom && !empty && (
          <button type="button" className="cx-jump" onClick={() => scrollToEnd(true)} aria-label="Jump to latest">
            <DownIcon />
          </button>
        )}
        {live?.pending && !approvalVisible && (
          <PendingBar
            step={live.pending}
            ui={approvalUi[live.pending.id]}
            onApprove={approve}
            onShow={() => approvalRef.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
          />
        )}
        {composer}
        <p className="cx-disclaimer">
          The assistant can make mistakes. Check specs before you order.{" "}
          {allowance && !allowance.subscriber && plans && (
            <button type="button" className="cx-plan-link" onClick={() => setShowPlans(true)}>
              {allowance.remaining <= 0 ? "Free preview ended · Keep going" : allowance.remaining === 1 ? "Last free message · Keep going" : "Free preview · Plans"}
            </button>
          )}{" "}
          {cartCount > 0 && <Link href="/cart">Cart ({cartCount})</Link>}
        </p>
      </div>

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
      {showPlans && plans && (
        <div className="pp-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && setShowPlans(false)}>
          <div className="pp-sheet" role="dialog" aria-modal="true" aria-labelledby="pp-sheet-title">
            <button type="button" className="pp-sheet-close" aria-label="Close" onClick={() => setShowPlans(false)}>
              ×
            </button>
            <h2 id="pp-sheet-title">Keep your shopping assistant</h2>
            <p className="pp-lede">Pick up right where you left off. Your chat and cart stay as they are.</p>
            <PlanPicker offer={plans} next={activeId.current ? `/c/${activeId.current}` : "/"} compact />
          </div>
        </div>
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

/** The shopper's message; a long pasted brief starts folded so it doesn't push the answer off screen. */
function UserText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 700;
  return (
    <div className="cx-bubble cx-bubble-me">
      {long && !open ? text.slice(0, 520).trimEnd() + "…" : text}
      {long && (
        <button type="button" className="cx-more" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/**
 * How many of Aurora's scouts are still out: the last "Sending N scouts" step, less the parts already done.
 * A web search counts as one helper too.
 */
function helpersAt(turn: { trace: Array<{ kind: string; text: string }>; groups: Array<{ done: boolean }> }): number {
  const steps = turn.trace.filter((t) => t.kind === "step");
  const last = steps[steps.length - 1]?.text ?? "";
  if (/^(Searching the web|Reading )/.test(last)) return 1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const m = steps[i].text.match(/^Sending (\d+) scouts?/);
    if (m) return Math.max(0, Math.min(3, Number(m[1]) - turn.groups.filter((g) => g.done).length));
  }
  return 0;
}

const isActiveStatus = (s: string) => s === "queued" || s === "running" || s === "waiting";

/* ---------- Approve & next (CONTRACTS.md §12) ---------- */

const KIND_TITLE: Record<string, string> = {
  captcha: "Amazon wants a robot check",
  choice: "Neon needs your choice",
  blocked: "Amazon needs you",
  sign_in: "Amazon wants you to sign in",
  checkout: "Ready to check out",
  email: "Send this email?",
};
const STATUS_LINE: Record<ApprovalRecord["status"], string> = { pending: "Superseded", approved: "Approved", expired: "Timed out", cancelled: "Stopped" };

/** Asks the full-screen browser for this step to open again (after "Back to chat"). */
const openBrowser = (cardId: string) => window.dispatchEvent(new CustomEvent("cx:open-browser", { detail: { cardId } }));

/** The approve button's label and state for one step. */
function approveButton(ui: ApprovalUi | undefined) {
  if (ui?.phase === "approving") return { label: "Approving…", disabled: true };
  if (ui?.phase === "approved") return { label: "Approved", disabled: true };
  if (ui?.phase === "error") return { label: "Try again", disabled: false };
  return { label: "Approve & next", disabled: false };
}

/**
 * The approvals of the reply being written, at the latest point of the chat: the step Neon is waiting on as a
 * message with its action, and the ones already settled as one status line each.
 */
function Approvals({
  records,
  pending,
  ui,
  onApprove,
  activeRef,
}: {
  records: ApprovalRecord[];
  pending: PendingStep | null;
  ui: Record<string, ApprovalUi>;
  onApprove: (stepId: string) => Promise<unknown>;
  activeRef: React.RefObject<HTMLDivElement | null>;
}) {
  const list = pending && !records.some((r) => r.id === pending.id) ? [...records, { id: pending.id, kind: pending.kind, message: pending.message, status: "pending" as const, createdAt: pending.createdAt }] : records;
  if (!list.length) return null;
  return (
    <>
      {list.map((r) => {
        const active = pending?.id === r.id && r.status === "pending";
        const state = ui[r.id];
        if (!active || state?.phase === "stale") {
          const line = state?.phase === "stale" ? state.message : state?.phase === "approved" ? "Approved" : STATUS_LINE[r.status];
          return (
            <div key={r.id} className={`cx-approval-done is-${state?.phase === "stale" ? "stale" : r.status}`}>
              <span aria-hidden>{r.status === "approved" || state?.phase === "approved" ? "✓" : "•"}</span> {line} · {r.message}
            </div>
          );
        }
        const b = approveButton(state);
        return (
          <div key={r.id} ref={activeRef} className="cx-msg cx-bot cx-approval" role="group" aria-labelledby={`ap-${r.id}`}>
            <div className="cx-bot-body">
              <div className="cx-bubble cx-bubble-bot cx-approval-card">
                <p className="cx-approval-title" id={`ap-${r.id}`}>
                  {KIND_TITLE[r.kind] ?? "Neon needs you"}
                </p>
                <p className="cx-approval-text">{r.message}</p>
                {state?.phase === "error" && (
                  <p className="cx-approval-error" role="alert">
                    {state.message}
                  </p>
                )}
                <div className="cx-approval-actions">
                  <button type="button" className="cx-btn cx-btn-primary cx-approve" disabled={b.disabled} aria-busy={state?.phase === "approving"} onClick={() => void onApprove(r.id)}>
                    {b.label}
                  </button>
                  {pending?.browser && state?.phase !== "approved" && (
                    <button type="button" className="cx-btn cx-approval-open" onClick={() => openBrowser(pending.browser!.cardId)}>
                      Open browser
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Settled approvals on a saved reply. */
function ApprovalLog({ records }: { records: ApprovalRecord[] }) {
  return (
    <>
      {records.map((r) => (
        <div key={r.id} className={`cx-approval-done is-${r.status}`}>
          <span aria-hidden>{r.status === "approved" ? "✓" : "•"}</span> {STATUS_LINE[r.status]} · {r.message}
        </div>
      ))}
    </>
  );
}

/** The step Neon is waiting on, just above the composer, while its message is scrolled out of view. */
function PendingBar({ step, ui, onApprove, onShow }: { step: PendingStep; ui: ApprovalUi | undefined; onApprove: (stepId: string) => Promise<unknown>; onShow: () => void }) {
  const b = approveButton(ui);
  return (
    <div className="cx-pending-bar" role="region" aria-label="Neon needs your approval">
      <button type="button" className="cx-pending-text" onClick={onShow} title="Show in the chat">
        {ui?.phase === "error" ? ui.message : ui?.phase === "stale" ? ui.message : step.message}
      </button>
      {ui?.phase !== "stale" && (
        <button type="button" className="cx-btn cx-btn-primary cx-approve" disabled={b.disabled} aria-busy={ui?.phase === "approving"} onClick={() => void onApprove(step.id)}>
          {b.label}
        </button>
      )}
    </div>
  );
}
