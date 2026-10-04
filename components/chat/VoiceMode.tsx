"use client";
// Hands-free voice conversation, like ChatGPT's voice mode: listen → answer → read it aloud → listen again.
// Product and kit cards still land in the chat behind it.

import { useEffect, useRef, useState } from "react";
import { MicIcon, XIcon } from "./ui";
import { listen, speak, speakable, stopSpeaking, type Recognizer } from "./voice";

type Phase = "listening" | "thinking" | "speaking" | "paused";

const LABEL: Record<Phase, string> = {
  listening: "Listening…",
  thinking: "Working on it…",
  speaking: "Tap to interrupt",
  paused: "Tap the circle to talk",
};

export default function VoiceMode({ onSend, onClose }: { onSend: (text: string) => Promise<string | null>; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("paused");
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const rec = useRef<Recognizer | null>(null);
  const closed = useRef(false);
  const phaseRef = useRef<Phase>("paused");
  const send = useRef(onSend);
  send.current = onSend;

  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  function startListening() {
    stopSpeaking();
    rec.current?.abort();
    setHeard("");
    setNote(null);
    go("listening");
    const r = listen({
      onText: setHeard,
      onEnd: async (text, err) => {
        rec.current = null;
        if (closed.current || phaseRef.current !== "listening") return;
        if (err === "not-allowed" || err === "service-not-allowed") {
          setNote("Microphone access is blocked. Allow it in your browser settings, then try again.");
          return go("paused");
        }
        if (!text) return go("paused");
        go("thinking");
        const reply = await send.current(text);
        if (closed.current) return;
        if (!reply) {
          setNote("That didn’t go through. Tap to try again.");
          return go("paused");
        }
        setSaid(speakable(reply));
        go("speaking");
        await speak(reply);
        if (!closed.current && (phaseRef.current as Phase) === "speaking") startListening();
      },
    });
    if (!r) {
      setNote("Voice input isn’t available in this browser.");
      go("paused");
    }
    rec.current = r;
  }

  useEffect(() => {
    closed.current = false;
    startListening();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      closed.current = true;
      rec.current?.abort();
      stopSpeaking();
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function tapOrb() {
    if (phase === "listening") rec.current?.stop();
    else if (phase === "speaking" || phase === "paused") startListening();
  }

  return (
    <div className={`vm vm-${phase}`} role="dialog" aria-label="Voice mode">
      <div className="vm-stage">
        <button type="button" className="vm-orb" onClick={tapOrb} aria-label={LABEL[phase]}>
          <span className="vm-ring" />
          <span className="vm-ring vm-ring-2" />
          <span className="vm-core">{phase === "paused" && <MicIcon />}</span>
        </button>
        <p className="vm-label">{LABEL[phase]}</p>
        <p className="vm-caption">{note ?? (phase === "listening" || phase === "thinking" ? heard : phase === "speaking" ? said : "")}</p>
      </div>
      <div className="vm-bar">
        <button type="button" className="vm-end" onClick={onClose} aria-label="End voice mode">
          <XIcon size={22} />
        </button>
      </div>
    </div>
  );
}
