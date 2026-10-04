"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const IDEAS = [
  "Workshop surprise: handy tools and gadgets for DIY guys",
  "Camping and outdoor gear for weekend trips",
  "Desk and office gadgets for remote workers",
  "Kitchen tools and gadgets for home cooks",
];

/** Brief form + live progress for the AI box designer. */
export default function BoxBuilder() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [price, setPrice] = useState("49");
  const [items, setItems] = useState("4");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function build(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLog([]);
    try {
      const r = await fetch("/admin/boxes/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief, price, items: Number(items) }) });
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error || "The build failed.");
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const c = await reader.read();
        if (c.done) break;
        buf += dec.decode(c.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "progress") setLog((l) => [...l.slice(-30), ev.note]);
          else if (ev.type === "found" && ev.done) setLog((l) => [...l.slice(-30), `✓ ${ev.group}: ${ev.cards.length} shortlisted`]);
          else if (ev.type === "error") throw new Error(ev.error);
          else if (ev.type === "done") {
            router.push(`/admin/boxes/${ev.boxId}?notice=${encodeURIComponent("Box designed. Review it, then publish.")}`);
            return;
          }
        }
      }
      throw new Error("The connection dropped. If the box appears in the list, it was saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The build failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={build} className="box-builder">
      <label>
        What should be in it?
        <textarea rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. Workshop surprise: handy tools and gadgets for DIY guys" required disabled={busy} />
      </label>
      <div className="box-ideas">
        {IDEAS.map((i) => (
          <button type="button" key={i} onClick={() => setBrief(i)} disabled={busy}>
            {i}
          </button>
        ))}
      </div>
      <div className="box-row">
        <label>
          Price (USD)
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required disabled={busy} />
        </label>
        <label>
          Items per box
          <input inputMode="numeric" value={items} onChange={(e) => setItems(e.target.value)} required disabled={busy} />
        </label>
      </div>
      <button className="a-btn a-btn-primary" disabled={busy || !brief.trim()}>
        {busy ? "Designing… (2-4 minutes)" : "Design box with AI"}
      </button>
      {log.length > 0 && (
        <ul className="box-log" aria-live="polite">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {error && <p className="notice err">{error}</p>}
    </form>
  );
}
