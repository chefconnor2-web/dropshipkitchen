// A booking's return address: back to the chat whose Book button was tapped (only a well-formed id).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatParam } from "../lib/chat-session";

test("chatParam carries a chat id into the Stripe return URL, and nothing else", () => {
  const f = (v?: string) => {
    const form = new FormData();
    if (v !== undefined) form.set("chat", v);
    return chatParam(form);
  };
  assert.equal(f("cmv750n8d00007daut30apw0f"), "&chat=cmv750n8d00007daut30apw0f");
  assert.equal(f(), "");
  assert.equal(f("https://evil.example"), "");
  assert.equal(f("a&s=1"), "");
});
