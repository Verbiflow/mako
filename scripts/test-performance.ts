import assert from "node:assert/strict"
import type { ChatMessage } from "@mako/host/contracts/conversation-session"
import { reconcileMessages } from "../src/lib/reconcile.ts"

const previous: ChatMessage = {
  id: "assistant-1",
  role: "assistant",
  blocks: [
    { type: "toolResult", id: "tool-1", text: "done" },
    { type: "toolCall", id: "tool-2", arguments: { path: "one" } },
  ],
}
const same = structuredClone(previous)
assert.equal(reconcileMessages([previous], [same])[0], previous)
const rewritten: ChatMessage = {
  ...structuredClone(previous),
  blocks: [
    { type: "toolResult", id: "tool-1", text: "fail" },
    { type: "toolCall", id: "tool-2", arguments: { path: "two" } },
  ],
}
assert.equal(reconcileMessages([previous], [rewritten])[0], rewritten)

console.log("message reconciliation passed")
