import assert from "node:assert/strict"
import { devinPermissionTitle } from "../electron/providers/devin/permissions.ts"

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
