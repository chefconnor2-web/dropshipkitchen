import { revoke } from "@/lib/mcp-auth";
import { cors, preflight } from "@/lib/mcp-http";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export async function POST(req: Request) {
  await revoke(new URLSearchParams(await req.text()).get("token") ?? "");
  return cors(new Response(null, { status: 200 }));
}
