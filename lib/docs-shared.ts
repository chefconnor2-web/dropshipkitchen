// Documents in the chat: a long paste or an attached text/PDF file goes to Neon as a document instead of
// sitting in the message box (a phone can't paste a million characters into a text field). Shared by the
// chat panel and the server.

import { MAX_MESSAGE_CHARS } from "@/lib/limits";

/** A paste longer than this becomes a document attachment instead of message text. */
export const PASTE_AS_DOC_CHARS = 3000;
export const MAX_DOCS = 3;
/** All text documents in one message together. */
export const MAX_DOC_CHARS = MAX_MESSAGE_CHARS;
/** A PDF, base64-encoded (about 20 MB of file). */
export const MAX_PDF_B64 = 28_000_000;

export interface DocUpload {
  name: string;
  kind: "text" | "pdf";
  /** The text itself, or the PDF as base64. */
  data: string;
}

/** What the transcript keeps about a document (the content itself only goes to the model). */
export interface DocInfo {
  name: string;
  kind: "text" | "pdf";
  /** Characters (text) or bytes (PDF). */
  size: number;
}

export const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|xml|html?|log|ya?ml)$/i;

export function docLabel(d: DocInfo): string {
  if (d.kind === "pdf") return d.size >= 1_000_000 ? `PDF · ${(d.size / 1_000_000).toFixed(1)} MB` : `PDF · ${Math.max(1, Math.round(d.size / 1000))} KB`;
  return `${d.size.toLocaleString("en-US")} characters`;
}

/** Checks uploads from the client: names, kinds and sizes. Returns the docs to use, or an error to show. */
export function cleanDocs(raw: unknown): { docs: DocUpload[]; error?: string } {
  if (!Array.isArray(raw) || !raw.length) return { docs: [] };
  if (raw.length > MAX_DOCS) return { docs: [], error: `Up to ${MAX_DOCS} documents per message.` };
  const docs: DocUpload[] = [];
  let chars = 0;
  for (const x of raw) {
    const o = (x ?? {}) as Record<string, unknown>;
    const kind = o.kind === "pdf" ? "pdf" : o.kind === "text" ? "text" : null;
    if (!kind || typeof o.data !== "string" || !o.data) return { docs: [], error: "That document couldn't be read." };
    const name = (typeof o.name === "string" ? o.name : "Document").replace(/[\r\n]+/g, " ").slice(0, 120) || "Document";
    if (kind === "text") {
      chars += o.data.length;
      if (chars > MAX_DOC_CHARS) return { docs: [], error: `Documents can be up to ${MAX_DOC_CHARS.toLocaleString("en-US")} characters in total.` };
    } else if (o.data.length > MAX_PDF_B64 || !/^[A-Za-z0-9+/=]+$/.test(o.data.slice(0, 2000))) return { docs: [], error: "PDFs can be up to about 20 MB." };
    docs.push({ name, kind, data: o.data });
  }
  return { docs };
}

export function docInfo(d: DocUpload): DocInfo {
  return { name: d.name, kind: d.kind, size: d.kind === "pdf" ? Math.floor((d.data.length * 3) / 4) : d.data.length };
}
