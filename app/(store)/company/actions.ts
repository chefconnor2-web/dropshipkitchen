"use server";

import { redirect } from "next/navigation";
import { getMember } from "@/lib/session";
import { acceptInvite, createCompany, invite, setPolicy } from "@/lib/company";

const back = (q: Record<string, string>) => redirect(`/company?${new URLSearchParams(q)}`);

export async function createCompanyAction(form: FormData) {
  const me = await getMember();
  if (!me) redirect("/account?next=/company");
  const r = await createCompany(me.id, String(form.get("name") ?? ""));
  back(r.error ? { error: r.error } : { saved: "created" });
}

export async function inviteAction(form: FormData) {
  const me = await getMember();
  if (!me) redirect("/account?next=/company");
  const r = await invite(me.id, String(form.get("email") ?? ""), String(form.get("role") ?? "traveler"));
  back(r.error ? { error: r.error } : { saved: "invited" });
}

export async function policyAction(form: FormData) {
  const me = await getMember();
  if (!me) redirect("/account?next=/company");
  const r = await setPolicy(me.id, String(form.get("policy") ?? ""), String(form.get("currency") ?? ""));
  back(r.error ? { error: r.error } : { saved: "policy" });
}

export async function joinAction(form: FormData) {
  const token = String(form.get("t") ?? "");
  const me = await getMember();
  if (!me) redirect(`/account?next=${encodeURIComponent(`/company/join?t=${token}`)}`);
  const r = await acceptInvite(token, me);
  back(r.error ? { error: r.error } : { saved: "joined" });
}
