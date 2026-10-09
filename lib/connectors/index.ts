// Every connector the chat can use. Add new ones here.
import type Anthropic from "@anthropic-ai/sdk";
import type { Connector } from "./types";
import { duffelConnector } from "./duffel";
import { liteapiConnector } from "./liteapi";

export const CONNECTORS: Connector[] = [duffelConnector, liteapiConnector];

export function enabledConnectors(): Connector[] {
  return CONNECTORS.filter((c) => c.enabled());
}

export function connectorTools(): Anthropic.Beta.BetaTool[] {
  return enabledConnectors().flatMap((c) => c.tools);
}

export function connectorPrompt(today: string): string {
  return enabledConnectors()
    .map((c) => c.prompt(today))
    .join("\n");
}

/** The connector that owns this tool, if any (and only while it's enabled). */
export function connectorFor(tool: string): Connector | undefined {
  return enabledConnectors().find((c) => c.tools.some((t) => t.name === tool));
}
