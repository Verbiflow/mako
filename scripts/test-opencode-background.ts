import assert from "node:assert/strict"
import type { OpenCodeEvent, ShellInfo } from "@opencode/client"
import { OpenCodeShells } from "../electron/providers/opencode/background.ts"

// Event shapes recorded from opencode 2.0.1: the bash tool creates a shell
// tagged with its session and names it in the call's metadata.
const shell = (id: string, sessionID: string, status: ShellInfo["status"] = "running"): ShellInfo => ({
  id, status, command: "sleep 300", cwd: "/tmp", shell: "/bin/zsh", file: `/tmp/${id}.out`, metadata: { sessionID }, time: { started: 1 },
})
type Event<Type extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: Type }>
const created = (info: ShellInfo): Event<"shell.created"> => ({ id: "created", created: 1, type: "shell.created", data: { info } })
const exited = (id: string): Event<"shell.exited"> => ({ id: "exited", created: 1, type: "shell.exited", data: { id, exit: 0, status: "exited" } })
const deleted = (id: string): Event<"shell.deleted"> => ({ id: "deleted", created: 1, type: "shell.deleted", data: { id } })
const call = { sessionID: "root", assistantMessageID: "message", executed: true }
const durable = { aggregateID: "root", seq: 1, version: 2 as const }
const called = (shellID: string): Event<"session.tool.success"> => ({ id: "success", created: 1, type: "session.tool.success", durable,
  data: { ...call, id: `call-${shellID}`, content: [{ type: "text", text: "Command moved to the background" }], metadata: { shellID } } })
const failed = (shellID: string): Event<"session.tool.failed"> => ({ id: "failed", created: 1, type: "session.tool.failed", durable,
  data: { ...call, id: `call-${shellID}`, error: { type: "aborted", message: "aborted" }, metadata: { shellID } } })

const shells = new OpenCodeShells((sessionID) => sessionID === "root" || sessionID === "child")
assert.equal(shells.observe(created(shell("foreground", "root"))), undefined)
assert.equal(shells.observe(exited("foreground")), undefined)
assert.equal(shells.observe(called("foreground")), undefined, "a shell that exits before its call completes is foreground")
assert.equal(shells.observe(created(shell("background", "root"))), undefined)
assert.equal(shells.observe(called("background")), 1, "a shell still running when its call completes is background work")
assert.equal(shells.observe(created(shell("subagent", "child"))), undefined)
assert.equal(shells.observe(failed("subagent")), 2)
assert.equal(shells.observe(created(shell("elsewhere", "other"))), undefined)
assert.equal(shells.observe(called("elsewhere")), undefined, "another conversation's shell is not counted")
assert.equal(shells.observe(exited("background")), 1)
assert.equal(shells.observe(deleted("subagent")), 0)
console.log("PASS: OpenCode shells count while they outlive their call, for the conversation's sessions only")

const listed = [shell("a", "root"), shell("b", "child"), shell("c", "other"), shell("d", "root", "exited"), shell("e", "root", "killed")]
assert.deepEqual(shells.ending(listed).map((item) => item.id), ["a", "b"], "Stop ends the conversation's running shells, whatever started them")
for (const id of ["a", "b"]) { shells.observe(created(shell(id, "root"))); shells.observe(called(id)) }
assert.equal(shells.running, 2)
assert.equal(shells.reconcile([shell("a", "root")]), 1, "a shell the list no longer reports running is dropped")
assert.equal(shells.reconcile([shell("a", "root")]), undefined)
console.log("PASS: Stop ends every running shell of the conversation, and a reconnect drops shells that ended unseen")
