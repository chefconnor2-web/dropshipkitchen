import { neonKeyOk, ownerWho } from "@/lib/neon-browser";
import { acting } from "@/lib/acting";
import { publishableKey, isEmbedded } from "@/lib/stripe-customer";
import { stripe } from "@/lib/stripe";
import { config } from "@/lib/config";

// Neon Browser → Chit: check out the owner's CJ cart and return Stripe's embedded checkout (client secret),
// so payment happens inside the chat. Key-guarded, owner-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** The target of a Next.js redirect() thrown inside the action. */
function redirectTarget(e: unknown): string | null {
  const d = (e as { digest?: unknown })?.digest;
  if (typeof d !== "string" || !d.startsWith("NEXT_REDIRECT")) return null;
  return d.split(";")[2] ?? null;
}

export async function POST(req: Request) {
  if (!neonKeyOk(req.headers.get("x-neon-key"))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const who = await ownerWho();
  if (!who) return Response.json({ error: "No owner account is configured on Chit." }, { status: 500 });

  let body: { country?: unknown; postalCode?: unknown; express?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // no body is fine (ships to saved address)
  }
  const country = typeof body.country === "string" && body.country.length === 2 ? body.country.toUpperCase() : null;
  const shipTo = country ? { country, zip: typeof body.postalCode === "string" ? body.postalCode : "", tier: body.express ? ("express" as const) : ("standard" as const) } : undefined;
  const embedded = !!publishableKey();

  const target: string | null = await acting.run({ customerId: who.customerId, embedded, ...(shipTo ? { shipTo } : {}) }, async () => {
    const { checkout } = await import("@/app/(store)/actions");
    try {
      await checkout();
      return null;
    } catch (e) {
      const to = redirectTarget(e);
      if (to === null) throw e;
      return to;
    }
  });

  if (!target) return Response.json({ error: "Checkout didn't start. Try again." }, { status: 400 });
  if (/checkout\.stripe\.com|stripe\.com/.test(target)) return Response.json({ payUrl: target });
  const sid = /(cs_[A-Za-z0-9_]+)/.exec(target)?.[1];
  if (embedded && sid) {
    const s = await stripe().checkout.sessions.retrieve(sid);
    if (isEmbedded(s.ui_mode) && s.client_secret) return Response.json({ clientSecret: s.client_secret, publishableKey: publishableKey() });
  }
  const err = (() => { try { return new URL(target, config.siteUrl).searchParams.get("error"); } catch { return null; } })();
  return Response.json({ error: err ?? (target.includes("/cart") ? "Your cart is empty, or needs a shipping destination." : "Checkout stopped.") }, { status: 400 });
}
