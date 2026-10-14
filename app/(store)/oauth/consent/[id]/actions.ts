"use server";

import { redirect } from "next/navigation";
import { getMemberId } from "@/lib/session";
import { decide } from "@/lib/mcp-auth";

export async function consentAction(form: FormData) {
  const id = String(form.get("id") ?? "");
  const me = await getMemberId();
  if (!me) redirect(`/account?next=${encodeURIComponent(`/oauth/consent/${id}`)}`);
  const to = await decide(id, me, form.get("allow") === "1");
  // Expired or already answered: the page says so.
  redirect(to ?? `/oauth/consent/${id}`);
}
