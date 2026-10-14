"use server";

import { redirect } from "next/navigation";
import { endSession, getMemberId } from "@/lib/session";
import { decide } from "@/lib/mcp-auth";

export async function consentAction(form: FormData) {
  const id = String(form.get("id") ?? "");
  const me = await getMemberId();
  if (!me) redirect(`/oauth/consent/${encodeURIComponent(id)}`);
  // The Deny form has a hidden allow=0; the Allow form only says so through its button (not always sent), so
  // anything but an explicit 0 from the Deny form counts as allow.
  const to = await decide(id, me, form.get("allow") !== "0", form.get("access") === "read");
  // Expired or already answered: the page says so.
  redirect(to ?? `/oauth/consent/${id}`);
}

/** "Not you?": sign out here and come back to this same request to sign in with another email. */
export async function switchAccountAction(form: FormData) {
  const id = String(form.get("id") ?? "");
  await endSession();
  redirect(`/oauth/consent/${encodeURIComponent(id)}`);
}
