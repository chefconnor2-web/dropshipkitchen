import { authServerMetadata } from "@/lib/mcp-auth";
import { cors, preflight } from "@/lib/mcp-http";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;
export const GET = () => cors(Response.json(authServerMetadata()));
