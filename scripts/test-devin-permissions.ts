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
const kinds: (string | null | undefined)[] = []
for (const name of [devinToolName(tool), undefined]) {
  forward({ id: "fixture" }, { sessionId: "fixture", update: tool }, event => {
    if (event.type === "live-update" && event.update.kind === "tool") kinds.push(event.update.toolKind)
  }, () => {}, undefined, name)
}
assert.deepEqual(kinds, ["run_subagent", "other"], "Shared ACP uses only the provider-contributed native tool name")

const request = {
  sessionId: "fixture",
  toolCall: { toolCallId: "open" },
  options: [
    {
      optionId: "allow_session",
      kind: "allow_always",
      name: "Yes, allow calling mako_control_exec on the mako-control MCP server (this session)",
    },
  ],
} satisfies Parameters<typeof devinPermissionTitle>[0]
assert.equal(
  devinPermissionTitle(request),
  "mako-control: mako_control_exec"
)
assert.equal(devinPermissionTitle({ ...request, options: [] }), undefined)
assert.equal(
  devinPermissionTitle({
    ...request,
    options: [
      {
        ...request.options[0],
        name: "Yes, allow calling all tools on the mako-control MCP server (this session)",
      },
    ],
  }),
  undefined
)
console.log(
  "Devin names an individual MCP permission without confusing it with a server-wide grant"
)
