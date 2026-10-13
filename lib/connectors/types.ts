// A connector plugs one outside API into the chat: it adds tools the planner can call, a few lines of
// instructions, and cards the shopper sees. New APIs (flights today, more later) are added as one connector
// each and listed in lib/connectors/index.ts; the chat, checkout and admin stay shared.

import type Anthropic from "@anthropic-ai/sdk";
import type { ConnectorItem } from "@/lib/flights-shared";

export interface ConnectorContext {
  /** Live updates for the chat panel while a turn runs (progress notes, cards as they arrive). */
  progress: (note: string) => void;
  /** Shows cards; a card with the same id as one already shown this turn replaces it. */
  show: (group: string, items: ConnectorItem[]) => void;
  /** The chat this turn belongs to (e.g. to keep one browser per chat). */
  chatId: string;
}

export interface ToolResult {
  /** Text, or text plus images (e.g. a screenshot for the model to look at). */
  content: string | Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam>;
  isError?: boolean;
}

export interface Connector {
  id: string;
  /** Shown in admin and logs. */
  label: string;
  /** Off until its API key is set, so a missing key never breaks the chat. */
  enabled(): boolean;
  /** Extra instructions for the planner, added to its system prompt when enabled. */
  prompt(today: string): string;
  tools: Anthropic.Beta.BetaTool[];
  run(tool: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult>;
}
