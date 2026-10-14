import Link from "next/link";
import { getMember } from "@/lib/session";
import { joinAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Join your company", robots: { index: false } };

/** An emailed invitation: sign in with the invited email, then one tap to join. */
export default async function JoinPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t = "" } = await searchParams;
  const me = await getMember();
  return (
    <div className="wrap page narrow co">
      <h1 className="page-title">Join your company</h1>
      {!me ? (
        <p>
          Sign in with the email the invitation was sent to, and you’ll come straight back here.{" "}
          <Link className="btn primary" href={`/account?next=${encodeURIComponent(`/company/join?t=${t}`)}`}>
            Sign in
          </Link>
        </p>
      ) : (
        <form action={joinAction}>
          <input type="hidden" name="t" value={t} />
          <p>You’re signed in as {me.email}. Join to book work trips under your company’s travel policy and send receipts to its expenses.</p>
          <button className="btn primary">Join</button>
        </form>
      )}
    </div>
  );
}
