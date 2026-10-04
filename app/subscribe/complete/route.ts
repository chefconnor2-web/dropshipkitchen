// Stripe sends new subscribers here: save the subscription and the first box order, then show their account.
// It never signs anyone in (subscribing already required signing in with an emailed code).
import { redirect } from "next/navigation";
import { completeSubscriptionCheckout } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
  let ok = false;
  try {
    const sub = sessionId ? await completeSubscriptionCheckout(sessionId) : null;
    if (sub) ok = true;
  } catch (e) {
    console.error("[subscribe]", e);
  }
  redirect(ok ? "/account?welcome=1" : `/account?error=${encodeURIComponent("We couldn’t confirm your subscription yet. If you were charged, it will appear here shortly.")}`);
}
