import { resourceMetadata } from "@/lib/mcp-auth";
import { cors, preflight } from "@/lib/mcp-http";

// Served at /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/mcp.
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;
export const GET = () => cors(Response.json(resourceMetadata()));
