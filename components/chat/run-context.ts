"use client";
// What a live browser card needs from the chat around it: which chat it belongs to, the step (if any) the
// server is waiting on the shopper for, and how to resume it. Chat.tsx provides it; BrowserView.tsx reads it.
// Contract: docs/frontier-port/CONTRACTS.md (§ Take over).

import { createContext, useContext } from "react";
import type { PendingStep, ResumeResult, RunStatus } from "@/lib/run-shared";

/** How an approval looks while the shopper acts on it (the server decides the outcome; this only mirrors it). */
export type ApprovalUi =
  | { phase: "approving" }
  | { phase: "approved" }
  /** Failed or rejected for a reason worth retrying (the network): the same step can be tried again. */
  | { phase: "error"; message: string }
  /** The step was superseded, expired or finished elsewhere: its action is gone for good. */
  | { phase: "stale"; message: string };

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
  /** Stops the active run (the same as the chat's Stop button). Available while a take-over covers the chat. */
  stop: () => Promise<void>;
  /**
   * Approve & next: resumes exactly `stepId` through the server. One request per step at a time (repeat taps
   * share it); the result is mirrored in `approvals[stepId]`. Shared by the chat message, the pending bar and
   * the full-screen browser, so they always agree. See CONTRACTS.md §12.
   */
  approve: (stepId: string) => Promise<ResumeResult>;
  approvals: Record<string, ApprovalUi>;
}

export const RunContext = createContext<BrowserRunContext>({
  chatId: null,
  pending: null,
  runStatus: null,
  resume: async () => ({ accepted: false, reason: "not_waiting", message: "Nothing is waiting on you.", current: null }),
  stop: async () => {},
  approve: async () => ({ accepted: false, reason: "not_waiting", message: "Nothing is waiting on you.", current: null }),
  approvals: {},
});

export const useRunContext = () => useContext(RunContext);
