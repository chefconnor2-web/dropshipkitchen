// A small, fast vision helper for the live browser: given one goal ("set the pick-up date to Oct 23 and press
// Search"), it looks at the screenshot, decides a few actions (taps by pixel, typing, keys, or the page's smart
// actions), runs them, looks again, and repeats until the goal is done or it is stuck. It runs server-side next
// to the browser, on a cheap fast model, with only the latest screenshot in context, so each step is one quick
// call. It never goes near payment: it stops on any payment or checkout page.

import Anthropic from "@anthropic-ai/sdk";
import { costMicros } from "@/lib/ai-cost";
import { browserApi, inBrowser, type PageState } from "@/lib/browser";

const VISION_MODEL = process.env.VISION_MODEL?.trim() || "claude-haiku-4-5";
const MAX_STEPS = 10;
const PAYMENT = /[/?&=._-](pay|payment|checkout|billing)\b/i;

const TOOL: Anthropic.Tool = {
  name: "browser_actions",
  description: "The next actions to run on the page, in order (1-5), or done/stuck. Coordinates are pixels on the screenshot.",
  input_schema: {
    type: "object",
    properties: {
      seeing: { type: "string", description: "One short line: what the screenshot shows that matters for the goal" },
      actions: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["tap", "type", "key", "scroll", "click_text", "select", "wait"] },
            x: { type: "number" },
            y: { type: "number" },
            text: { type: "string", description: "type: the text; click_text: the visible words of the button or link" },
            key: { type: "string", enum: ["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp"] },
            dy: { type: "number", description: "scroll: pixels down (negative is up)" },
            field: { type: "string", description: "select: the dropdown's label" },
            value: { type: "string", description: "select: the option, e.g. 10:30" },
            ms: { type: "number" },
          },
          required: ["type"],
        },
      },
      done: { type: "boolean", description: "true when the screenshot shows the goal is complete (then no actions)" },
      stuck: { type: "string", description: "Set only if the goal can't be done here (e.g. a robot check or the option doesn't exist): why, in one line" },
    },
    required: ["seeing", "actions", "done"],
  },
};

const SYSTEM = `You drive a desktop browser (1280×800) by looking at screenshots, as fast as possible.
Each turn: look at the screenshot, then call browser_actions with the next few actions toward the goal. Batch actions you're sure of (e.g. tap a calendar day, then tap the next one) so it takes as few turns as possible.
- tap x/y: pixel coordinates of the center of what to tap, read carefully off this screenshot.
- Calendars: page months with the arrow until the right month shows, then tap the day number in that month's grid. Check the month and year headings.
- Time dropdowns: prefer select {field, value}; if it's a custom list, tap it open then tap the time.
- After a step that changes the page, stop the batch there and look again.
- done=true only when the screenshot shows the goal is complete. stuck when it can't be done here.
Never enter card or payment details, never press a final Book/Pay button, never sign in.`;

export interface VisionResult {
  ok: boolean;
  steps: number;
  /** What happened, for the main assistant (one line per turn). */
  log: string[];
  why?: string;
  page: PageState;
  micros: number;
}

/** Works toward `goal` in this chat's live browser, by screenshot. Starts from `start` when the caller has one. */
export async function visionAgent(chatId: string, goal: string, opts: { signal: AbortSignal; start?: PageState; progress?: (note: string) => void }): Promise<VisionResult> {
  const { signal } = opts;
  const client = new Anthropic();
  const log: string[] = [];
  let micros = 0;
  let page = opts.start?.screenshot ? opts.start : (await inBrowser(chatId, (id) => browserApi.state(id, signal), signal)).result;
  for (let step = 1; step <= MAX_STEPS; step++) {
    signal.throwIfAborted();
    if (PAYMENT.test(page.url)) return { ok: false, steps: step - 1, log, why: "reached a payment page", page, micros };
    if (page.needsShopper) return { ok: false, steps: step - 1, log, why: "the page shows a robot check", page, micros };
    if (!page.screenshot) page = (await inBrowser(chatId, (id) => browserApi.state(id, signal), signal)).result;
    if (!page.screenshot) return { ok: false, steps: step - 1, log, why: "no screenshot", page, micros };
    const r = await client.messages.create(
      {
        model: VISION_MODEL,
        max_tokens: 600,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `Goal: ${goal}\nPage: ${page.url}\n${log.length ? `Done so far:\n${log.join("\n")}` : "First look."}` },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: page.screenshot } },
            ],
          },
        ],
      },
      { signal },
    );
    micros += costMicros(r.model, r.usage);
    const call = r.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const out = (call?.input ?? {}) as { seeing?: string; actions?: Array<Record<string, unknown>>; done?: boolean; stuck?: string };
    if (out.done) return { ok: true, steps: step, log: [...log, `${step}. done: ${out.seeing ?? ""}`], page, micros };
    if (out.stuck) return { ok: false, steps: step, log: [...log, `${step}. stuck: ${out.stuck}`], why: out.stuck, page, micros };
    const actions = (out.actions ?? []).slice(0, 5).filter((a) => ["tap", "type", "key", "scroll", "click_text", "select", "wait"].includes(String(a.type)));
    if (!actions.length) return { ok: false, steps: step, log, why: "no next action", page, micros };
    opts.progress?.(out.seeing ? `Looking: ${out.seeing.slice(0, 80)}` : "Working the page…");
    const acted = (await inBrowser(chatId, (id) => browserApi.act(id, actions, signal), signal)).result;
    page = acted;
    const res = (acted.results ?? []).map((x) => (x.ok ? "✓" : `✗ ${x.why ?? ""}`)).join(" ");
    log.push(`${step}. saw: ${(out.seeing ?? "").slice(0, 100)} → did: ${actions.map(describe).join(", ")}${res ? ` (${res})` : ""}`);
  }
  return { ok: false, steps: MAX_STEPS, log, why: `not done after ${MAX_STEPS} looks`, page, micros };
}

function describe(a: Record<string, unknown>): string {
  switch (a.type) {
    case "tap":
      return `tap ${Math.round(Number(a.x))},${Math.round(Number(a.y))}`;
    case "type":
      return "type text";
    case "key":
      return `key ${a.key}`;
    case "scroll":
      return `scroll ${a.dy ?? 600}`;
    case "click_text":
      return `click "${String(a.text ?? "").slice(0, 30)}"`;
    case "select":
      return `select ${a.field}=${a.value}`;
    default:
      return String(a.type);
  }
}
