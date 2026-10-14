import Link from "next/link";
import { getMemberId } from "@/lib/session";
import { connectedApps, mcpUrl } from "@/lib/mcp-auth";
import { disconnectAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Use Chit in Claude and ChatGPT" };

/** How to add Chit to Claude (custom connector) or ChatGPT, and the apps connected to this account. */
export default async function ConnectPage() {
  const me = await getMemberId();
  const apps = me ? await connectedApps(me) : [];
  return (
    <div className="wrap page narrow co">
      <p className="eyebrow">Connectors</p>
      <h1 className="page-title">Use Chit in Claude and ChatGPT</h1>
      <p>Ask Claude or ChatGPT to find flights, hotels and rental cars with Chit, check your trips and receipts, or log work expenses. You still pay on Chit’s checkout in your own browser: the assistant only gets booking links.</p>

      <section className="co-card">
        <h2 className="section-title">Connector URL</h2>
        <p>
          <code className="co-code">{mcpUrl()}</code>
        </p>
        <h3>Claude</h3>
        <ol className="co-points">
          <li>
            In Claude, open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>.
          </li>
          <li>Name it Chit and paste the URL above. Leave the advanced OAuth fields empty.</li>
          <li>Tap Connect, sign in to Chit with your email code, and allow it.</li>
          <li>In a chat, turn Chit on from the tools menu and ask, for example: “Find me a flight from Vancouver to Miami on Nov 3 with Chit.”</li>
        </ol>
        <h3>ChatGPT</h3>
        <ol className="co-points">
          <li>
            Turn on developer mode (<b>Settings → Apps → Advanced settings</b>), then <b>Create app</b>.
          </li>
          <li>Paste the URL above, choose OAuth, and sign in to Chit when asked.</li>
        </ol>
      </section>

      <section className="co-card">
        <h2 className="section-title">Connected apps</h2>
        {!me ? (
          <p>
            <Link href="/account?next=/connect">Sign in</Link> to see the apps connected to your account.
          </p>
        ) : apps.length === 0 ? (
          <p className="muted">No apps connected yet.</p>
        ) : (
          <ul className="co-people">
            {apps.map((a) => (
              <li key={a.grantId}>
                <span>
                  {a.name} <span className="muted small">· last signed in {a.since.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                </span>
                <form action={disconnectAction}>
                  <input type="hidden" name="grant" value={a.grantId} />
                  <button className="btn">Disconnect</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p>
        <Link href="/">← Back to Neon</Link>
      </p>
    </div>
  );
}
