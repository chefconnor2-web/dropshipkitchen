"use client";
// Voice in the browser, no extra services: speech-to-text with the Web Speech API (Chrome, Edge, Safari)
// and read-aloud with speechSynthesis (every modern browser).

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Recognizer {
  start(): void;
  stop(): void;
  abort(): void;
}

export function speechInputSupported(): boolean {
  return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export function speechOutputSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Listens once (until the speaker pauses). onText gets the running transcript (final + interim) on every
 * result; onEnd gets the final transcript, or "" when nothing was heard, plus an error code if one occurred.
 */
export function listen(opts: { onText: (text: string) => void; onEnd: (finalText: string, error?: string) => void; continuous?: boolean }): Recognizer | null {
  const C = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!C) return null;
  const r = new C();
  r.lang = navigator.language || "en-CA";
  r.interimResults = true;
  r.continuous = !!opts.continuous;
  r.maxAlternatives = 1;
  let finalText = "";
  let error: string | undefined;
  r.onresult = (e: any) => {
    let interim = "";
    finalText = "";
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    opts.onText((finalText + interim).trim());
  };
  r.onerror = (e: any) => {
    error = e.error;
  };
  r.onend = () => opts.onEnd(finalText.trim(), error);
  try {
    r.start();
  } catch {
    return null;
  }
  return r;
}

/** Plain spoken text from the assistant's markdown. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*([-•]|\d+[.)])\s+/gm, "")
    .replace(/\$(\d+)\.(\d\d)\b/g, "$$$1")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.\s*\./g, ".")
    .trim();
}

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const lang = (navigator.language || "en").slice(0, 2);
  const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const pool = mine.length ? mine : voices;
  return (
    pool.find((v) => /natural|neural|premium|enhanced/i.test(v.name)) ??
    pool.find((v) => /google|samantha|aria|jenny|daniel/i.test(v.name)) ??
    pool.find((v) => v.default) ??
    pool[0]
  );
}

let speakToken = 0;

/**
 * Reads text aloud, a sentence at a time (Chrome cuts off long utterances). Resolves when finished or
 * stopped. Any new speak() or stopSpeaking() cancels the previous one.
 */
export function speak(text: string, onStart?: () => void): Promise<void> {
  if (!speechOutputSupported()) return Promise.resolve();
  const synth = window.speechSynthesis;
  synth.cancel();
  const token = ++speakToken;
  const chunks = speakable(text).match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const voice = pickVoice();
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (token !== speakToken || i >= chunks.length) return resolve();
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      if (voice) u.voice = voice;
      u.rate = 1.05;
      u.onstart = () => i === 1 && onStart?.();
      u.onend = next;
      u.onerror = next;
      synth.speak(u);
    };
    next();
  });
}

export function stopSpeaking() {
  speakToken++;
  if (speechOutputSupported()) window.speechSynthesis.cancel();
}

/** iOS only plays speech started from a tap; call this inside the tap that opens voice mode. */
export function unlockSpeech() {
  if (!speechOutputSupported()) return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  window.speechSynthesis.speak(u);
}
