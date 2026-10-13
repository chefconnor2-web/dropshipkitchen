// GET /api/assistant/runs/:id/events?after=<seq>: the run's frames as server-sent events. A snapshot first
// (unless every frame after `after` is still buffered), then live frames, `: ping` every 15 s, and the stream
// closes after the run ends. See docs/frontier-port/CONTRACTS.md §6.
import { findOwnChat } from "@/lib/chat-session";
import { getRun, subscribe } from "@/lib/runs";
import { formatSse, isActive, type RunFrame } from "@/lib/run-shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const terminal = (f: RunFrame) => f.type === "done" || (f.type === "status" && !isActive(f.status));

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const got = await getRun(id);
  if (!got || !(await findOwnChat(got.chatId))) return Response.json({ error: "Not found" }, { status: 404 });
  const a = new URL(req.url).searchParams.get("after");
  const after = a !== null && /^\d+$/.test(a) ? Number(a) : null;
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const write = (s: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          close();
        }
      };
      const sub = await subscribe(id, after, (f) => {
        write(formatSse(f));
        if (terminal(f)) close();
      });
      if (!sub) return close();
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      cleanup = () => {
        clearInterval(ping);
        sub.unsubscribe();
      };
      req.signal.addEventListener("abort", close, { once: true });
      write(": connected\n\n");
      for (const f of sub.initial) write(formatSse(f));
      if (sub.ended || sub.initial.some(terminal)) close();
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no", connection: "keep-alive" },
  });
}
