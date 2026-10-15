"use server";

// The owner's taps for money decisions: approve or decline a paid booking held for a risk check, and handle a
// dispute (cancel the trip and accept it, or send the evidence now). /admin is behind HTTP Basic auth.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { approveHeldFlight, declineHeldFlight } from "@/lib/flight-booking";
import { approveHeldStay, declineHeldStay } from "@/lib/hotel-booking";
import { cancelForDispute, submitEvidence } from "@/lib/disputes";

const msg = (r: unknown) => (r && typeof r === "object" && "error" in r && typeof (r as { error: unknown }).error === "string" ? (r as { error: string }).error : null);

function back(path: string, error: string | null): never {
  revalidatePath(path);
  redirect(error ? `${path}?error=${encodeURIComponent(error)}` : path);
}

export async function heldFlightAction(form: FormData) {
  const id = String(form.get("id") ?? "");
  const r = form.get("decision") === "approve" ? await approveHeldFlight(id) : await declineHeldFlight(id);
  back("/admin/flights", msg(r));
}

export async function heldStayAction(form: FormData) {
  const id = String(form.get("id") ?? "");
  const r = form.get("decision") === "approve" ? await approveHeldStay(id) : await declineHeldStay(id);
  back("/admin/hotels", msg(r));
}

export async function disputeAction(form: FormData) {
  const id = String(form.get("id") ?? "");
  const r = form.get("do") === "cancel" ? await cancelForDispute(id) : await submitEvidence(id);
  back("/admin/disputes", msg(r));
}
