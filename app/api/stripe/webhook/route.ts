import { config } from "@/lib/config";
import { stripe } from "@/lib/stripe";
import { markOrderPaidFromSession } from "@/lib/orders";
import { completeFlightBooking } from "@/lib/flight-booking";
import { after } from "next/server";
import { completeSubscriptionCheckout, orderForInvoice, updateSubscriptionFromStripe } from "@/lib/subscriptions";
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
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode === "subscription") await completeSubscriptionCheckout(session);
    // Flights book with the airline after we answer Stripe (it can take a while); the status lock stops a retry double-booking.
    else if (session.metadata?.flightBookingId) after(() => completeFlightBooking(session).catch((e) => console.error("[flights] booking failed:", e)));
    else await markOrderPaidFromSession(session);
  }
  // Every paid month of a mystery box subscription becomes a box order (once per invoice).
  if (event.type === "invoice.paid") {
    const invoice = event.data.object as Stripe.Invoice;
    if (invoice.id && invoice.parent?.subscription_details) await orderForInvoice(invoice.id);
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    await updateSubscriptionFromStripe(event.data.object as Stripe.Subscription);
  }
  return Response.json({ received: true });
}
