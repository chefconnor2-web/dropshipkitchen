import Link from "next/link";

/** Under a booking form's title: where the filled-in details came from, or how to get them filled in. */
export function PrefillNote({ from, next }: { from: "saved" | "account" | null; next: string }) {
  if (from === "saved") return <p className="muted small prefill-note">Filled in from your saved details. Check the names match the ID of whoever is travelling.</p>;
  if (from === "account") return <p className="muted small prefill-note">Filled in from your account. Check the names match the ID of whoever is travelling.</p>;
  return (
    <p className="muted small prefill-note">
      Tick &ldquo;Save my details&rdquo; below and next time this fills itself, or <Link href={`/account?next=${encodeURIComponent(next)}`}>sign in</Link>.
    </p>
  );
}
