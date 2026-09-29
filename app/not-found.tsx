import Link from "next/link";

export default function NotFound() {
  return (
    <main className="wrap store-main">
      <h1>Not found</h1>
      <Link href="/shop">Back to the shop →</Link>
    </main>
  );
}
