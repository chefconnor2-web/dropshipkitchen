"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { cancelGift, parseRecipients, sendGifts, type GiftDesign } from "@/lib/gifts";

/** Admin Gifts: send a branded item to the ticked customers plus anyone typed in. */
export async function sendGiftsAction(form: FormData) {
  const picked = form.getAll("pick").map(String);
  const typed = parseRecipients(String(form.get("extra") ?? ""));
  if (typed.bad.length) redirect(`/admin/gifts?error=${encodeURIComponent(`Couldn't read: ${typed.bad.slice(0, 3).join(" · ")}`)}`);
  const fromList = (await prisma.customer.findMany({ where: { email: { in: picked } }, select: { email: true, name: true } })).map((c) => ({ email: c.email, name: c.name }));
  const seen = new Set<string>();
  const recipients = [...fromList, ...typed.recipients].filter((r) => !seen.has(r.email) && seen.add(r.email));
  const r = await sendGifts({
    variantId: String(form.get("variantId") ?? ""),
    design: String(form.get("design") ?? "dark") as GiftDesign,
    recipients,
    message: String(form.get("message") ?? ""),
    budgetCents: Math.round(Number(form.get("budget")) * 100),
  });
  revalidatePath("/admin/gifts");
  if ("error" in r) redirect(`/admin/gifts?error=${encodeURIComponent(r.error!)}`);
  redirect(`/admin/gifts?sent=${r.sent}&skipped=${r.skipped}`);
}

export async function cancelGiftAction(form: FormData) {
  await cancelGift(String(form.get("id") ?? ""));
  revalidatePath("/admin/gifts");
  redirect("/admin/gifts");
}
