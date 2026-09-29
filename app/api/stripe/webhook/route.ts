import { config } from "@/lib/config";
import { stripe } from "@/lib/stripe";
import { markOrderPaidFromSession } from "@/lib/orders";
import type Stripe from "stripe";

// Optional: the success page already confirms payment by retrieving the session from Stripe.
// Configure STRIPE_WEBHOOK_SECRET (e.g. via `stripe listen`) to also confirm server-to-server.
export async function POST(req: Request) {
  if (!config.stripe.webhookSecret) return new Response("Webhook secret not configured", { status: 400 });
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(
      await req.text(),
      req.headers.get("stripe-signature") || "",
      config.stripe.webhookSecret,
    );
  } catch (e) {
    return new Response(`Invalid signature: ${e instanceof Error ? e.message : e}`, { status: 400 });
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    await markOrderPaidFromSession(event.data.object as Stripe.Checkout.Session);
  }
  return Response.json({ received: true });
}
