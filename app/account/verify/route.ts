// One-tap email sign-in.
import { redirect } from "next/navigation";
import { redeemLoginToken, signIn } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const customer = token ? await redeemLoginToken(token) : null;
  if (!customer) redirect(`/account?error=${encodeURIComponent("That sign-in link has expired or was already used. Ask for a new one.")}`);
  await signIn(customer.id);
  redirect("/account");
}
