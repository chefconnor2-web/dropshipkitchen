// A fast browser helper for the live browser: given one goal ("set the pick-up date to Oct 23 and press
// Search"), Claude works the page with Anthropic's browser use toolset (browser_toolset_20260801): it reads the
// page's elements as refs, clicks and fills them, and checks screenshots, until the goal is done or it's stuck.
// It runs server-side next to the browser on a fast, cheap model with thinking off. The browser service runs
// each call (browser-service/browser-tool.mjs). It never goes near payment: it stops on any payment or checkout
// page, and the prompt forbids card details, sign-in and final Book/Pay buttons.

import Anthropic from "@anthropic-ai/sdk";
import { costMicros } from "@/lib/ai-cost";
import { browserApi, inBrowser, type PageState } from "@/lib/browser";

const VISION_MODEL = process.env.VISION_MODEL?.trim() || "claude-haiku-5-5";
const MAX_TURNS = 16;
const MAX_MS = 100_000;
const PAYMENT = /[/?&=._-](pay|payment|checkout|billing)\b/i;

// One tab per chat, and no raw mouse-button or key holds.
const TOOLSET = {
  type: "browser_toolset_20260801",
  configs: {
    new_tab: { enabled: false },
    list_tabs: { enabled: false },
    switch_tab: { enabled: false },
    close_tab: { enabled: false },
    left_mouse_down: { enabled: false },
    left_mouse_up: { enabled: false },
    hold_key: { enabled: false },
  },
} as unknown as Anthropic.ToolUnion;

const SYSTEM = `You operate a desktop browser (1280×800) to finish one goal, as fast as possible: few turns, several actions per turn.
- Work from element refs: read_page (filter "interactive") or find, then left_click / form_input on refs. Native <select> dropdowns: form_input with the option text. Use coordinates only for things without refs.
- Date pickers: open the field, page months with the next-month arrow until the right month and year show, then click the day in that month. Check the result.
- After clicking something that opens or changes part of the page, read it again (read_page with filter "interactive", or a screenshot) before relying on old refs.
- Close anything in the way (cookie banners, popups) first.
- Batch actions you're sure of in one turn, and end the batch with a screenshot when you need to see the result.
- When the goal is complete, reply with one line starting "DONE:" saying what's on screen. If it can't be done here (a robot check, the option doesn't exist), reply "STUCK:" and why. No other prose.
Never enter card or payment details, never press a final Book/Pay/Reserve button, never sign in or create an account.`;

export interface VisionResult {
  ok: boolean;
  steps: number;
  /** What happened, for the main assistant (one line per turn). */
  log: string[];
  why?: string;
  page: PageState;
  micros: number;
}

type ToolUse = Anthropic.ToolUseBlock & { toolset_name?: string | null };

/** Works toward `goal` in this chat's live browser. */
export async function visionAgent(chatId: string, goal: string, opts: { signal: AbortSignal; start?: PageState; progress?: (note: string) => void; maxMs?: number }): Promise<VisionResult> {
  const { signal } = opts;
  const client = new Anthropic();
  const log: string[] = [];
  const t0 = Date.now();
  let micros = 0;
  const state = async () => (await inBrowser(chatId, (id) => browserApi.state(id, signal), signal)).result;
  const finish = async (ok: boolean, steps: number, why?: string): Promise<VisionResult> => ({ ok, steps, log, ...(why ? { why } : {}), page: await state(), micros });

  // The first look: what's on screen and its interactive elements, in one round trip.
  const first = (await inBrowser(chatId, (id) => browserApi.tool(id, [{ name: "screenshot", input: {} }, { name: "read_page", input: { filter: "interactive" } }], signal), signal)).result;
  if (PAYMENT.test(first.url)) return finish(false, 0, "reached a payment page");
  if (first.needsShopper) return finish(false, 0, "the page shows a robot check");
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: `Goal: ${goal}\nThe page now (${first.url}): a screenshot, then its interactive elements.` },
        ...(first.results.flatMap((r) => r.content) as Anthropic.ContentBlockParam[]),
      ],
    },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    signal.throwIfAborted();
    if (Date.now() - t0 > (opts.maxMs ?? MAX_MS)) return finish(false, turn - 1, "ran out of time");
    const r = await client.messages.create(
      {
        model: VISION_MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        tools: [TOOLSET],
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        messages,
      } as Anthropic.MessageCreateParamsNonStreaming,
      { signal },
    );
    micros += costMicros(r.model, r.usage);
    messages.push({ role: "assistant", content: r.content as Anthropic.ContentBlockParam[] });
    const said = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
    const calls = r.content.filter((b): b is ToolUse => b.type === "tool_use");
    if (!calls.length) {
      log.push(`${turn}. ${said.slice(0, 160)}`);
      if (/^DONE:/i.test(said)) return finish(true, turn);
      return finish(false, turn, said.replace(/^STUCK:\s*/i, "").slice(0, 200) || "stopped without finishing");
    }
    opts.progress?.(progressNote(calls));
    const ran = (await inBrowser(chatId, (id) => browserApi.tool(id, calls.map((c) => ({ name: c.name, input: c.input })), signal), signal)).result;
    log.push(`${turn}. ${calls.map(describe).join(", ")}${ran.results.some((x) => x.isError) ? " (one failed)" : ""}`);
    // Older screenshots aren't needed again: keep the request small and fast (thinking is off, so nothing
    // depends on the earlier turns staying byte-identical).
    for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result" && Array.isArray(b.content)) b.content = b.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[earlier screenshot]" } : c));
    messages.push({
      role: "user",
      content: calls.map((c, i) => {
        const res = ran.results[i] ?? { content: [{ type: "text", text: "Not executed." }], isError: true };
        return { type: "tool_result", tool_use_id: c.id, toolset_name: "browser", content: res.content, ...(res.isError ? { is_error: true } : {}) } as Anthropic.ToolResultBlockParam;
      }),
    });
    if (PAYMENT.test(ran.url)) return finish(false, turn, "reached a payment page");
    if (ran.needsShopper) return finish(false, turn, "the page shows a robot check");
  }
  return finish(false, MAX_TURNS, `not done after ${MAX_TURNS} turns`);
}

function progressNote(calls: ToolUse[]): string {
  const c = calls.find((x) => x.name !== "screenshot" && x.name !== "read_page") ?? calls[0];
  if (/click/.test(c.name)) return "Tapping on the page…";
  if (c.name === "form_input" || c.name === "type") return "Filling in the page…";
  return "Looking at the page…";
}

function describe(c: ToolUse): string {
  const i = (c.input ?? {}) as Record<string, unknown>;
  const t = i.target as { type?: string; ref?: string; x?: number; y?: number } | undefined;
  const where = t ? (t.ref ? ` ${t.ref}` : ` ${Math.round(Number(t.x))},${Math.round(Number(t.y))}`) : "";
  switch (c.name) {
    case "type":
      return "type text";
    case "form_input":
      return `set${where}`;
    case "key":
      return `key ${String(i.text ?? "").slice(0, 20)}`;
    case "find":
      return `find "${String(i.query ?? "").slice(0, 30)}"`;
    case "navigate":
      return "navigate";
    default:
      return `${c.name}${where}`;
  }
}
