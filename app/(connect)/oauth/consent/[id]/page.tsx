import Link from "next/link";
import { getMember } from "@/lib/session";
import { pendingRequest } from "@/lib/mcp-auth";
import { config } from "@/lib/config";
import BrandMark from "@/components/BrandMark";
import { consentAction, switchAccountAction } from "./actions";
import SignIn from "./SignIn";
import { AllowButton } from "./Buttons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect to Chit", robots: { index: false } };

/** A steady colour for an app's monogram, from its name. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return /claude/i.test(name) ? 18 : /chatgpt|openai/i.test(name) ? 160 : h;
}

function AppTile({ name }: { name: string }) {
  return (
    <span className="cn-tile cn-app" style={{ ["--h" as string]: hue(name) }} aria-hidden>
      {name.trim().charAt(0).toUpperCase() || "A"}
    </span>
  );
}

function Pair({ app, linked }: { app: string; linked?: boolean }) {
  return (
    <div id="cn-pair" className={`cn-pair${linked ? " linked" : ""}`} role="img" aria-label={`${app} and ${config.storeName}`}>
      <span className="cn-tile cn-chit">
        <BrandMark size={46} />
      </span>
      <span className="cn-wire" aria-hidden />
      <AppTile name={app} />
    </div>
  );
}

function Steps({ at }: { at: 1 | 2 }) {
  const names = ["Sign in", "Review access", "Connected"];
  return (
    <div className="cn-steps">
      <div className="cn-bar" aria-hidden>
        {names.map((n, i) => (
          <i key={n} className={i + 1 <= at ? "on" : ""} />
        ))}
      </div>
      <p>
        Step {at} of 3: {names[at - 1]}
      </p>
    </div>
  );
}

const Icon = {
  search: <path d="M11 4a7 7 0 1 0 4.4 12.4L20 21M11 4a7 7 0 0 1 7 7" />,
  bag: <path d="M5 8h14l-1 12H6L5 8Zm4 0V6a3 3 0 0 1 6 0v2" />,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />,
  doc: <path d="M7 3h7l4 4v14H7V3Zm7 0v4h4M10 12h5M10 16h5" />,
  lock: <path d="M6 11h12v9H6v-9Zm2 0V8a4 4 0 0 1 8 0v3" />,
  shield: <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Zm-3 9 2 2 4-4" />,
  undo: <path d="M9 7 5 11l4 4M5 11h9a5 5 0 0 1 0 10h-2" />,
  clock: <path d="M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" />,
};

function Ico({ d }: { d: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d}
    </svg>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="cn-main">
      <div className="cn-top">
        <span className="cn-word">{config.storeName}</span>
      </div>
      <section className="cn-card">{children}</section>
      <footer className="cn-foot">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
      </footer>
    </main>
  );
}

/** An AI app (Claude, ChatGPT…) asks to use the customer's Chit account: sign in, then allow or deny. */
export default async function ConsentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, r] = await Promise.all([getMember(), pendingRequest(id)]);

  if (!r)
    return (
      <Shell>
        <div className="cn-state">
          <span className="cn-badge warn">
            <Ico d={Icon.clock} />
          </span>
          <h1 className="cn-title">This link has expired</h1>
          <p className="cn-sub">Connection links last a few minutes. Go back to your AI app and connect {config.storeName} again to get a new one.</p>
        </div>
      </Shell>
    );

  const app = r.client.name;
  const host = new URL(r.redirectUri).host;

  if (!me)
    return (
      <Shell>
        <Pair app={app} />
        <Steps at={1} />
        <h1 className="cn-title">Sign in to connect {app}</h1>
        <p className="cn-sub">Enter the email on your {config.storeName} account and we’ll send you a 6-digit code.</p>
        <SignIn next={`/oauth/consent/${id}`} />
        <p className="cn-fine">New to {config.storeName}? Signing in with your email creates your account.</p>
      </Shell>
    );

  return (
    <Shell>
      <Pair app={app} linked />
      <Steps at={2} />
      <h1 className="cn-title">
        Connect {app} to your {config.storeName} account
      </h1>
      <div className="cn-who">
        <span className="cn-avatar" aria-hidden>
          {(me.name || me.email).charAt(0).toUpperCase()}
        </span>
        <span className="cn-who-text">
          <b>{me.name || me.email}</b>
          {me.name ? <small>{me.email}</small> : null}
        </span>
        <form action={switchAccountAction}>
          <input type="hidden" name="id" value={id} />
          <button className="cn-link">Not you?</button>
        </form>
      </div>

      <h2 className="cn-h2">What {app} can do</h2>
      <ul className="cn-perms">
        <li>
          <Ico d={Icon.search} />
          <span>
            <b>Search and prepare bookings</b>
            <small>Flights, hotels, rental cars and products, with links to book them</small>
          </span>
        </li>
        <li>
          <Ico d={Icon.bag} />
          <span>
            <b>Manage your cart</b>
            <small>Add, change and remove items in your {config.storeName} cart</small>
          </span>
        </li>
        <li>
          <Ico d={Icon.spark} />
          <span>
            <b>Work with Neon</b>
            <small>Read your chats and ask Neon to do things, using your AI allowance</small>
          </span>
        </li>
        <li>
          <Ico d={Icon.doc} />
          <span>
            <b>See your trips</b>
            <small>Itineraries, receipts, your company’s travel policy and work expenses</small>
          </span>
        </li>
      </ul>

      <form action={consentAction} id="cn-allow">
        <input type="hidden" name="id" value={id} />
        <fieldset className="cn-access">
          <legend className="cn-h2">Access</legend>
          <label className="cn-opt">
            <input type="radio" name="access" value="full" defaultChecked />
            <span className="cn-opt-body">
              <b>Full access</b>
              <small>Also book, add to your cart, cancel bookings you confirm and run Neon tasks</small>
            </span>
          </label>
          <label className="cn-opt">
            <input type="radio" name="access" value="read" />
            <span className="cn-opt-body">
              <b>Read-only</b>
              <small>Search and look at your trips, cart and chats, but never buy or change anything</small>
            </span>
          </label>
        </fieldset>
      </form>
      <form action={consentAction} id="cn-deny" hidden>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="allow" value="0" />
      </form>

      <p className="cn-trust">
        <Ico d={Icon.lock} />
        <span>
          {app} never sees your card. You pay on {config.storeName} in your own browser, and you can disconnect it any time.
        </span>
      </p>

      <div className="cn-actions">
        <AllowButton form="cn-allow" label={`Allow and connect`} />
        <button className="cn-btn ghost" form="cn-deny">
          Cancel
        </button>
      </div>
      <p className="cn-fine">
        You’ll go back to <b>{host}</b>. Manage connected apps any time on the <Link href="/connect">Connect page</Link>.
      </p>
    </Shell>
  );
}
