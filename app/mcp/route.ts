import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { prisma } from "@/lib/db";
import { bearer, resourceMetadataUrl, SCOPE } from "@/lib/mcp-auth";
import { cors, preflight } from "@/lib/mcp-http";
import { chitMcpServer } from "@/lib/mcp-server";

// The Chit MCP endpoint (Streamable HTTP, stateless: one server per request, JSON responses). Every request
// needs an OAuth access token; without one, the 401 tells the app where to sign the customer in.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;
export const OPTIONS = preflight;

function unauthorized(why: string) {
  return cors(
    Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: why }, id: null },
      { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl()}", scope="${SCOPE}"` } },
    ),
  );
}

async function handle(req: Request): Promise<Response> {
  const who = await bearer(req.headers.get("authorization"));
  if (!who) return unauthorized("Sign in to Chit to use this connector.");
  const client = await prisma.mcpClient.findUnique({ where: { id: who.clientId }, select: { name: true } });
  const server = chitMcpServer({ customerId: who.customerId, clientId: who.clientId, clientName: client?.name ?? "an app" });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req, { authInfo: { token: who.token, clientId: who.clientId, scopes: [SCOPE], extra: { customerId: who.customerId } } });
    return cors(res);
  } finally {
    // JSON mode: the response is complete once handleRequest returns.
    void server.close();
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
