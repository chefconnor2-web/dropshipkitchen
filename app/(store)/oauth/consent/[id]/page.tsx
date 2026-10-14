import { redirect } from "next/navigation";
import { getMember } from "@/lib/session";
import { pendingRequest } from "@/lib/mcp-auth";
import { consentAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect to Chit", robots: { index: false } };

/** An AI app (Claude, ChatGPT…) asks to use the customer's Chit account: sign in, then allow or deny. */
export default async function ConsentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMember();
  if (!me) redirect(`/account?next=${encodeURIComponent(`/oauth/consent/${id}`)}`);
  const r = await pendingRequest(id);
  if (!r)
    return (
      <div className="wrap page narrow co">
        <h1 className="page-title">This link has expired</h1>
        <p>Go back to the app and connect Chit again.</p>
      </div>
    );
  const host = new URL(r.redirectUri).host;
  return (
    <div className="wrap page narrow co">
      <p className="eyebrow">Connect an app</p>
      <h1 className="page-title">{r.client.name} wants to use your Chit account</h1>
      <p>
        Signed in as <b>{me.email}</b>. After you allow it, it returns to <b>{host}</b>.
      </p>
      <div className="co-card">
        <p>It will be able to:</p>
        <ul className="co-points">
          <li>Search flights, hotels, rental cars and products for you, and make booking links.</li>
          <li>Add to and change your Chit cart.</li>
          <li>Read your Neon chats and ask Neon to do things for you (using your Chit AI allowance).</li>
          <li>See your trips, itineraries and receipts, read your company’s travel policy and log work expenses.</li>
        </ul>
        <p className="muted small">It can’t pay for anything or see card details. You pay on Chit’s own checkout page, in your browser. Disconnect it any time on the Connect page.</p>
      </div>
      <form action={consentAction}>
        <input type="hidden" name="id" value={id} />
        <fieldset className="co-card co-access">
          <legend>Access</legend>
          <label>
            <input type="radio" name="access" value="full" defaultChecked /> <b>Full access</b>: it can also book, add to your cart, cancel bookings you confirm, and ask Neon to do things.
          </label>
          <label>
            <input type="radio" name="access" value="read" /> <b>Read-only</b>: it can search and look at your trips, cart and chats, but never buy or change anything.
          </label>
        </fieldset>
        <div className="co-actions">
          <button className="btn primary" name="allow" value="1">
            Allow
          </button>
        </div>
      </form>
      <form action={consentAction} className="co-actions">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="allow" value="0" />
        <button className="btn">Deny</button>
      </form>
    </div>
  );
}
