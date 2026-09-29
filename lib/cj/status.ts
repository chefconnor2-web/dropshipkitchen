import { prisma } from "@/lib/db";
import { cjConfigured } from "@/lib/config";

export type CjStatus =
  | { state: "NOT_CONFIGURED" }
  | { state: "UNVERIFIED" }
  | { state: "CONNECTED"; at: Date; requestId: string | null; path: string }
  | { state: "ERROR"; at: Date; message: string | null; path: string };

/** Connection state as evidenced by the most recent real call to CJ. */
export async function cjStatus(): Promise<CjStatus> {
  if (!cjConfigured()) return { state: "NOT_CONFIGURED" };
  const last = await prisma.cjApiCall.findFirst({ orderBy: { createdAt: "desc" } });
  if (!last) return { state: "UNVERIFIED" };
  return last.ok
    ? { state: "CONNECTED", at: last.createdAt, requestId: last.requestId, path: last.path }
    : { state: "ERROR", at: last.createdAt, message: last.message, path: last.path };
}
