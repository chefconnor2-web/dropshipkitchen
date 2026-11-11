import test from "node:test";
import assert from "node:assert/strict";
import { parseResidentialProxy } from "../proxy.mjs";

test("leaves proxy disabled when the setting is empty", () => {
  assert.equal(parseResidentialProxy(undefined), null);
  assert.equal(parseResidentialProxy("  "), null);
});

test("parses a proxy endpoint without authentication", () => {
  assert.deepEqual(parseResidentialProxy("proxy.example.com:8080"), {
    server: "http://proxy.example.com:8080",
  });
});

test("parses authenticated endpoints with or without an explicit scheme", () => {
  const expected = {
    server: "http://proxy.example.com:8080",
    username: "user",
    password: "pass",
  };
  assert.deepEqual(parseResidentialProxy("user:pass@proxy.example.com:8080"), expected);
  assert.deepEqual(parseResidentialProxy("http://user:pass@proxy.example.com:8080"), expected);
});

test("decodes URL-encoded proxy credentials", () => {
  assert.deepEqual(parseResidentialProxy("user%40region:p%3Aass@proxy.example.com:8080"), {
    server: "http://proxy.example.com:8080",
    username: "user@region",
    password: "p:ass",
  });
});

test("rejects unsupported or incomplete proxy configuration", () => {
  assert.throws(() => parseResidentialProxy("socks5://proxy.example.com:1080"), /HTTP proxy/);
  assert.throws(() => parseResidentialProxy("proxy.example.com"), /host and port/);
  assert.throws(() => parseResidentialProxy("user@proxy.example.com:8080"), /both a username and password/);
  assert.throws(() => parseResidentialProxy("http://proxy.example.com:8080/path"), /no path/);
});
