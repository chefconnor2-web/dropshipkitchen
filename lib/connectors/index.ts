// Every connector the chat can use. Add new ones here.
import type Anthropic from "@anthropic-ai/sdk";
import type { Audience, Connector } from "./types";
import { duffelConnector } from "./duffel";
import { instacartConnector } from "./instacart";

export const CONNECTORS: Connector[] = [duffelConnector, instacartConnector];

const NOBODY: Audience = { tester: false, country: "" };

/** Connectors with their keys set and offered to this shopper. */
export function enabledConnectors(who: Audience = NOBODY): Connector[] {
  return CONNECTORS.filter((c) => c.enabled() && (c.available?.(who) ?? true));
}

export function connectorTools(who?: Audience): Anthropic.Beta.BetaTool[] {
  return enabledConnectors(who).flatMap((c) => c.tools);
}

export function connectorPrompt(today: string, who?: Audience): string {
  return enabledConnectors(who)
    .map((c) => c.prompt(today))
    .join("\n");
}

/** The connector that owns this tool, if any (and only while it's enabled for this shopper). */
export function connectorFor(tool: string, who?: Audience): Connector | undefined {
  return enabledConnectors(who).find((c) => c.tools.some((t) => t.name === tool));
}
