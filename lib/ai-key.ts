// Which Anthropic key Neon runs on. Bring your own key: a shopper saves their own Anthropic API key (My details),
// and every model call in their runs uses it, so the AI bills their Anthropic account, not the store's. Without
// one, the store's ANTHROPIC_API_KEY (if set) is the fallback for the web chat, under the plan allowance.
// The Chit connector (Claude, ChatGPT) needs no key at all: the customer's own assistant does the thinking, and
// Neon's tools are offered there only when the customer has saved their own key (lib/mcp-server.ts).
//
// Every `new Anthropic()` in a run goes through anthropic() below, which reads the key from the run's async
// context, so connectors and the vision agent deep inside a run pick it up without being passed it.

import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { openToken, sealToken } from "@/lib/gmail";

export interface KeyOwner {
  customerId: string | null;
  visitorId: string | null;
}

/** The key a run uses, and whether it's the shopper's own (their own key: no plan allowance, nothing billed to us). */
export interface RunKey {
  apiKey: string;
  own: boolean;
}

const runKey = new AsyncLocalStorage<RunKey>();

/** Runs `fn` with model calls on `key`. */
export function withKey<T>(key: RunKey, fn: () => Promise<T>): Promise<T> {
  return runKey.run(key, fn);
}

/** The key of the run in progress, if any. */
export function currentKey(): RunKey | undefined {
  return runKey.getStore();
}

/** An Anthropic client on the current run's key (else the store's ANTHROPIC_API_KEY). */
export function anthropic(): Anthropic {
  const k = runKey.getStore();
  return k ? new Anthropic({ apiKey: k.apiKey }) : new Anthropic();
}

/** The store's own key, for the web chat's fallback and admin tools. */
export function platformKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

/** Shown wherever a run can't start or its key was refused. */
export const NO_KEY_MESSAGE =
  "Neon needs an AI key. Add your own Anthropic API key in My details (it bills your Anthropic account), or use Chit from Claude or ChatGPT as a connector, with no key needed.";
export const OWN_KEY_REFUSED =
  "Anthropic refused your AI key. Check it in My details: it may have been deleted, or your Anthropic account may be out of credit.";

const where = (o: KeyOwner) => (o.customerId ? { customerId: o.customerId } : o.visitorId ? { visitorId: o.visitorId } : null);

async function rowFor(o: KeyOwner) {
  // Signed in: the account's key, else one saved in this browser before signing in.
  if (o.customerId) {
    const row = await prisma.aiKey.findUnique({ where: { customerId: o.customerId } });
    if (row) return row;
  }
  return o.visitorId ? prisma.aiKey.findUnique({ where: { visitorId: o.visitorId } }) : null;
}

/** The shopper's own key, decrypted, or null. */
export async function ownKey(o: KeyOwner): Promise<string | null> {
  const row = await rowFor(o);
  if (!row) return null;
  try {
    return await openToken(row.keyEnc);
  } catch {
    return null;
  }
}

/** "…abcd" for the shopper's saved key, or null. */
export async function ownKeyHint(o: KeyOwner): Promise<string | null> {
  return (await rowFor(o))?.hint ?? null;
}

/** The key a run for this shopper uses: theirs, else the store's. Null: none (they need to add one). */
export async function resolveKey(o: KeyOwner, opts: { allowPlatform?: boolean } = {}): Promise<RunKey | null> {
  const own = await ownKey(o);
  if (own) return { apiKey: own, own: true };
  const p = opts.allowPlatform === false ? null : platformKey();
  return p ? { apiKey: p, own: false } : null;
}

/** Looks like an Anthropic API key (sk-ant-…), before asking Anthropic. */
export function plausibleKey(k: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k);
}

/** Asks Anthropic whether the key works (listing models costs nothing). Null when it does, else why not. */
export async function testKey(k: string): Promise<string | null> {
  try {
    await new Anthropic({ apiKey: k, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 1 });
    return null;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return "Anthropic didn't accept that key. Copy it again from console.anthropic.com.";
    if (e instanceof Anthropic.PermissionDeniedError) return "That key isn't allowed to use the API. Check its permissions in console.anthropic.com.";
    return "Couldn't reach Anthropic to check the key. Try again in a moment.";
  }
}

export async function saveOwnKey(o: KeyOwner, k: string): Promise<{ hint: string }> {
  const w = where(o);
  if (!w) throw new Error("no owner");
  const keyEnc = await sealToken(k);
  const hint = `…${k.slice(-4)}`;
  const existing = await prisma.aiKey.findFirst({ where: w });
  if (existing) await prisma.aiKey.update({ where: { id: existing.id }, data: { keyEnc, hint } });
  else await prisma.aiKey.create({ data: { ...w, keyEnc, hint } });
  return { hint };
}

/** Forgets the shopper's key (the account's and this browser's). */
export async function deleteOwnKey(o: KeyOwner): Promise<void> {
  const or = [o.customerId ? { customerId: o.customerId } : null, o.visitorId ? { visitorId: o.visitorId } : null].filter((x) => x !== null);
  if (or.length) await prisma.aiKey.deleteMany({ where: { OR: or } });
}
