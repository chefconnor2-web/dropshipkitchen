"use server";

import { redirect } from "next/navigation";
import { getMemberId } from "@/lib/session";
import { decide } from "@/lib/mcp-auth";

export async function consentAction(form: FormData) {
  const id = String(form.get("id") ?? "");
  const me = await getMemberId();
  if (!me) redirect(`/account?next=${encodeURIComponent(`/oauth/consent/${id}`)}`);
  // The Deny form has a hidden allow=0; the Allow form only says so through its button (not always sent), so
  // anything but an explicit 0 from the Deny form counts as allow.
  const to = await decide(id, me, form.get("allow") !== "0", form.get("access") === "read");
  // Expired or already answered: the page says so.
  redirect(to ?? `/oauth/consent/${id}`);
}
