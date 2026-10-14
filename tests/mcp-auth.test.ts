import { test } from "node:test";
import assert from "node:assert/strict";
import { authServerMetadata, okRedirectUri, resourceMetadata } from "../lib/mcp-auth";

test("redirect URIs: https anywhere, http only on this machine, no fragments", () => {
  assert.ok(okRedirectUri("https://claude.ai/api/mcp/auth_callback"));
  assert.ok(okRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect"));
  assert.ok(okRedirectUri("http://localhost:6274/oauth/callback"));
  assert.ok(okRedirectUri("http://127.0.0.1:33418/cb"));
  assert.ok(!okRedirectUri("http://evil.example/cb"));
  assert.ok(!okRedirectUri("https://claude.ai/cb#x"));
  assert.ok(!okRedirectUri("javascript:alert(1)"));
  assert.ok(!okRedirectUri(42));
});

test("discovery metadata points at the MCP endpoint and requires PKCE", () => {
  const as = authServerMetadata();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  const pr = resourceMetadata();
  assert.ok(pr.resource.endsWith("/mcp"));
  assert.deepEqual(pr.authorization_servers, [as.issuer]);
});
