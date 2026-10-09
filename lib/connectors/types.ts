// A connector plugs one outside API into the chat: it adds tools the planner can call, a few lines of
// instructions, and cards the shopper sees. New APIs (flights today, more later) are added as one connector
// each and listed in lib/connectors/index.ts; the chat, checkout and admin stay shared.

import type Anthropic from "@anthropic-ai/sdk";
import type { ConnectorItem } from "@/lib/flights-shared";

export interface ConnectorContext {
  /** Live updates for the chat panel while a turn runs (progress notes, cards as they arrive). */
  progress: (note: string) => void;
  show: (group: string, items: ConnectorItem[]) => void;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Who is chatting, for connectors that aren't offered to everyone (a test rollout, a country). */
export interface Audience {
  /** This browser was turned on for features still in testing (/admin/instacart). */
  tester: boolean;
  /** Ship-to country code. */
  country: string;
}

export interface Connector {
  id: string;
  /** Shown in admin and logs. */
  label: string;
  /** Off until its API key is set, so a missing key never breaks the chat. */
  enabled(): boolean;
  /** Offered only to some shoppers; everyone when left out. */
  available?(who: Audience): boolean;
  /** Extra instructions for the planner, added to its system prompt when enabled. */
  prompt(today: string): string;
  tools: Anthropic.Beta.BetaTool[];
  run(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult>;
}
