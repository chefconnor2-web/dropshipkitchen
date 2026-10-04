// Stripe sends new subscribers here: save the subscription and the first box order, sign them in, show their account.
import { redirect } from "next/navigation";
import { completeSubscriptionCheckout } from "@/lib/subscriptions";
import { signIn } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
  let ok = false;
  try {
    const sub = sessionId ? await completeSubscriptionCheckout(sessionId) : null;
    if (sub) {
      if (sub.canSignIn) await signIn(sub.customerId);
      ok = true;
    }
  } catch (e) {
    console.error("[subscribe]", e);
  }
  redirect(ok ? "/account?welcome=1" : `/account?error=${encodeURIComponent("We couldn’t confirm your subscription yet. If you were charged, it will appear here shortly.")}`);
}
