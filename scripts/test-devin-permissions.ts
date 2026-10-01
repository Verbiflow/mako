import assert from "node:assert/strict"
import { devinPermissionTitle } from "../electron/providers/devin/permissions.ts"
import { devinToolName } from "../electron/providers/devin/tool-name.ts"
import { forward } from "../electron/acp-notifications.ts"

const tool = {
  sessionUpdate: "tool_call", toolCallId: "child-call", title: "Task", kind: "other",
  _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
} satisfies Parameters<typeof devinToolName>[0]
assert.equal(devinToolName(tool), "run_subagent")
assert.equal(devinToolName({ ...tool, _meta: { "cognition.ai/inferenceToolName": 17 } }), undefined)
assert.equal(devinToolName({ ...tool, _meta: undefined }), undefined)
const named: [string | undefined, string | undefined][] = []
for (const name of [devinToolName(tool), undefined]) {
  forward({ id: "fixture" }, { sessionId: "fixture", update: tool }, event => {
    if (event.type === "live-update" && event.update.kind === "tool") named.push([event.update.name, event.update.toolKind])
  }, () => {}, undefined, name)
}
assert.deepEqual(named, [["run_subagent", "other"], [undefined, "other"]], "Shared ACP names a tool only from the provider's hook and keeps ACP's kind beside it")

const request = {
  sessionId: "fixture",
  toolCall: { toolCallId: "open" },
  options: [
    {
      optionId: "allow_session",
      kind: "allow_always",
      name: "Yes, allow calling mako_computer_js on the mako-computer MCP server (this session)",
    },
  ],
} satisfies Parameters<typeof devinPermissionTitle>[0]
assert.equal(
  devinPermissionTitle(request),
  "mako-computer: mako_computer_js"
)
assert.equal(devinPermissionTitle({ ...request, options: [] }), undefined)
const command = "printf '%s' 'approval-nonce' >> '/tmp/mako-provider-e2e/allow.txt'"
assert.equal(devinPermissionTitle({ ...request, toolCall: { ...request.toolCall, _meta: { "cognition.ai/editableCommand": command } } }), command,
  "native command metadata takes precedence over an unrelated fallback label")
for (const value of [null, 17, "", " ", "x".repeat(8193)]) {
  assert.equal(devinPermissionTitle({ ...request, options: [], toolCall: { ...request.toolCall, _meta: { "cognition.ai/editableCommand": value } } }), undefined,
    "malformed or oversized native command metadata is not presented as a command")
}
assert.equal(
  devinPermissionTitle({
    ...request,
    options: [
      {
        ...request.options[0],
        name: "Yes, allow calling all tools on the mako-computer MCP server (this session)",
      },
    ],
  }),
  undefined
)
console.log(
  "Devin displays native command evidence and names individual MCP permissions without confusing server-wide grants"
)
