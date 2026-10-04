// Old one-tap sign-in links (before sign-in codes). They no longer sign anyone in.
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export function GET() {
  redirect(`/account?error=${encodeURIComponent("Sign-in links have been replaced by codes. Enter your email to get a 6-digit code.")}`);
}
