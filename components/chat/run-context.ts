"use client";
// What a live browser card needs from the chat around it: which chat it belongs to, the step (if any) the
// server is waiting on the shopper for, and how to resume it. Chat.tsx provides it; BrowserView.tsx reads it.
// Contract: docs/frontier-port/CONTRACTS.md (§ Take over).

import { createContext, useContext } from "react";
import type { PendingStep, ResumeResult, RunStatus } from "@/lib/run-shared";

export interface BrowserRunContext {
  /** The chat this card is shown in (for minting live-view tokens). Null before the chat exists. */
  chatId: string | null;
  /** The server-owned step waiting on the shopper in this chat's active run, or null. */
  pending: PendingStep | null;
  /** The active run's status, or null when no run is active. */
  runStatus: RunStatus | null;
  /**
   * Tells the server the shopper finished `stepId`. Resolves with the server's answer; only
   * `{ accepted: true, stepId }` for this same step means the run carries on. Never throws (network
   * failures resolve as `{ accepted: false, reason: "not_waiting", ... }` with current: null).
   */
  resume: (stepId: string) => Promise<ResumeResult>;
}

export const RunContext = createContext<BrowserRunContext>({
  chatId: null,
  pending: null,
  runStatus: null,
  resume: async () => ({ accepted: false, reason: "not_waiting", message: "Nothing is waiting on you.", current: null }),
});

export const useRunContext = () => useContext(RunContext);
