import { stripe } from "@/lib/stripe";
import { publishableKey } from "@/lib/stripe-customer";
import EmbeddedPay from "./EmbeddedPay";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pay", robots: { index: false } };

/** An embedded Checkout session (made for the Chit card in Claude) opened in a browser instead. */
export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = /^cs_[A-Za-z0-9_]+$/.test(id) ? await stripe().checkout.sessions.retrieve(id).catch(() => null) : null;
  if (!s || s.ui_mode !== "embedded" || s.status !== "open" || !s.client_secret)
    return (
      <div className="wrap page narrow">
        <h1 className="page-title">{s?.status === "complete" ? "Paid" : "This payment link has expired"}</h1>
        <p>{s?.status === "complete" ? "Thanks, it’s paid. Your confirmation is on its way by email." : "Go back to the chat and ask for a new one."}</p>
      </div>
    );
  return (
    <div className="wrap page narrow">
      <EmbeddedPay clientSecret={s.client_secret} publishableKey={publishableKey()} />
    </div>
  );
}
