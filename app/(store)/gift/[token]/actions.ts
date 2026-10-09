"use server";

import { claimGift } from "@/lib/gifts";

export interface ClaimState {
  error?: string;
  done?: string;
  values?: Record<string, string>;
  n: number;
}

export async function claimGiftAction(prev: ClaimState, form: FormData): Promise<ClaimState> {
  const f = (k: string) => String(form.get(k) ?? "");
  const values = { name: f("name"), phone: f("phone"), line1: f("line1"), line2: f("line2"), city: f("city"), state: f("state"), postal: f("postal"), country: f("country") };
  const r = await claimGift(f("token"), values);
  return r.ok ? { done: r.orderNumber, n: prev.n + 1 } : { error: r.error, values, n: prev.n + 1 };
}
