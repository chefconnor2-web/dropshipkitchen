"use client";
// Hands-free voice conversation, like ChatGPT's voice mode: listen → answer → read it aloud → listen again.
// Product and kit cards still land in the chat behind it.

import { useEffect, useRef, useState } from "react";
import { MicIcon, XIcon } from "./ui";
import NeonOrb, { type OrbState } from "./NeonOrb";
import { listen, speak, speakable, stopSpeaking, type Recognizer } from "./voice";

type Phase = "listening" | "thinking" | "speaking" | "paused";

const LABEL: Record<Phase, string> = {
  listening: "Listening…",
  thinking: "Working on it…",
  speaking: "Tap to interrupt",
  paused: "Tap Neon to talk",
};

const ORB: Record<Phase, OrbState> = { listening: "listening", thinking: "thinking", speaking: "speaking", paused: "idle" };

export default function VoiceMode({ onSend, onClose }: { onSend: (text: string) => Promise<string | null>; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("paused");
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // Bumped per word heard or said, so Neon moves with the conversation.
  const [pulse, setPulse] = useState(0);
  const bump = () => setPulse((n) => n + 1);
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
      onText: (t) => {
        setHeard(t);
        bump();
      },
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
        await speak(reply, undefined, bump);
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
          <NeonOrb state={ORB[phase]} size={150} pulse={pulse} mic />
          {phase === "paused" && (
            <span className="vm-mic-badge">
              <MicIcon />
            </span>
          )}
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
