import Link from "next/link";
import { getMemberId } from "@/lib/session";
import { connectedApps, mcpUrl } from "@/lib/mcp-auth";
import { prisma } from "@/lib/db";
import { disconnectAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Use Chit in Claude and ChatGPT" };

/** How to add Chit to Claude (custom connector) or ChatGPT, and the apps connected to this account. */
export default async function ConnectPage() {
  const me = await getMemberId();
  const apps = me ? await connectedApps(me) : [];
  // What connected apps did, newest first (one row per tool call).
  const calls = me ? await prisma.mcpCall.findMany({ where: { customerId: me }, orderBy: { createdAt: "desc" }, take: 30 }) : [];
  const appNames = new Map((await prisma.mcpClient.findMany({ where: { id: { in: [...new Set(calls.map((c) => c.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  return (
    <div className="wrap page narrow co">
      <p className="eyebrow">Connectors</p>
      <h1 className="page-title">Use Chit in Claude and ChatGPT</h1>
      <p>Everything Neon does, in Claude or ChatGPT: flights, hotels and rental cars, shopping with your Chit cart, your Neon chats, trips and receipts, and work expenses. Flight, hotel and cart cards show right in the chat. You still pay on Chit’s checkout in your own browser: the assistant only gets booking links.</p>

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
                  {a.name} <span className="muted small">· {a.readOnly ? "read-only" : "full access"} · last signed in {a.since.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
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
      {calls.length > 0 && (
        <section className="co-card">
          <h2 className="section-title">Recent activity</h2>
          <ul className="co-people">
            {calls.map((c) => (
              <li key={c.id}>
                <span>
                  {c.tool.replace(/_/g, " ")} <span className="muted small">· {appNames.get(c.clientId) ?? "an app"}</span>
                </span>
                <span className={c.ok ? "muted small" : "small"}>
                  {c.ok ? "" : "failed · "}
                  {c.createdAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="muted small">
        <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link>
      </p>
      <p>
        <Link href="/">← Back to Neon</Link>
      </p>
    </div>
  );
}
