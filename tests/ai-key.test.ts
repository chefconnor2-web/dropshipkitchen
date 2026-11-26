// Bring your own key: which Anthropic key a run's model calls use, and what the shopper is told when there's
// no key or a key is refused (the chat's "Add my AI key" button looks for "AI key" in the message).
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { NO_KEY_MESSAGE, OWN_KEY_REFUSED, anthropic, currentKey, plausibleKey, withKey } from "../lib/ai-key";
import { runErrorMessage } from "../lib/runs";

const OWN = { apiKey: "sk-ant-api03-own-own-own-own-own-own", own: true };
const STORE = { apiKey: "sk-ant-api03-store-store-store-store", own: false };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const apiError = (Cls: new (...a: any[]) => InstanceType<typeof Anthropic.APIError>, status: number, message: string) => new Cls(status, { type: "error", error: { type: "x", message } }, message, new Headers());

test("plausibleKey accepts Anthropic keys only", () => {
  assert.equal(plausibleKey("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx_yz-0123"), true);
  assert.equal(plausibleKey("sk-proj-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(plausibleKey("sk-ant-short"), false);
  assert.equal(plausibleKey(" sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx "), false);
});

test("model calls inside a run use that run's key, and only inside it", async () => {
  assert.equal(currentKey(), undefined);
  await withKey(OWN, async () => {
    assert.equal(anthropic().apiKey, OWN.apiKey);
    // Deep inside the run (connectors, the vision agent) after an await: still the run's key.
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(anthropic().apiKey, OWN.apiKey);
  });
  await Promise.all([
    withKey(OWN, async () => (await new Promise((r) => setTimeout(r, 5)), assert.equal(currentKey()?.apiKey, OWN.apiKey))),
    withKey(STORE, async () => (await new Promise((r) => setTimeout(r, 1)), assert.equal(currentKey()?.apiKey, STORE.apiKey))),
  ]);
  assert.equal(currentKey(), undefined);
});

test("a refused key: fix your own, or add one when it was the store's", () => {
  const auth = apiError(Anthropic.AuthenticationError, 401, "invalid x-api-key");
  assert.equal(runErrorMessage(auth, OWN), OWN_KEY_REFUSED);
  assert.equal(runErrorMessage(auth, STORE), NO_KEY_MESSAGE);
  assert.equal(runErrorMessage(auth), NO_KEY_MESSAGE);
});

test("out of credit: their own account, or the store's", () => {
  const broke = apiError(Anthropic.BadRequestError, 400, "Your credit balance is too low to access the Anthropic API.");
  assert.match(runErrorMessage(broke, OWN), /out of credit/);
  assert.equal(runErrorMessage(broke, STORE), NO_KEY_MESSAGE);
});

test("key messages carry the words the chat's button looks for", () => {
  assert.match(NO_KEY_MESSAGE, /AI key/);
  assert.match(OWN_KEY_REFUSED, /AI key/);
  assert.doesNotMatch(runErrorMessage(apiError(Anthropic.RateLimitError, 429, "slow down"), OWN), /AI key/);
});
