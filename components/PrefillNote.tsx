import Link from "next/link";

/** Above a booking form: details came from your account, or sign in to have them filled in. */
export function PrefillNote({ signedIn, next }: { signedIn: boolean; next: string }) {
  return signedIn ? (
    <p className="muted small prefill-note">Filled in from your account. Check the names match the ID of whoever is travelling.</p>
  ) : (
    <p className="muted small prefill-note">
      <Link href={`/account?next=${encodeURIComponent(next)}`}>Sign in</Link> to have your details filled in.
    </p>
  );
}
