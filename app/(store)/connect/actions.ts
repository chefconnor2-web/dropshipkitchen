"use server";

import { redirect } from "next/navigation";
import { getMemberId } from "@/lib/session";
import { disconnect } from "@/lib/mcp-auth";

export async function disconnectAction(form: FormData) {
  const me = await getMemberId();
  if (!me) redirect("/account?next=/connect");
  await disconnect(me, String(form.get("grant") ?? ""));
  redirect("/connect");
}
