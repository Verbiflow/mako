import assert from "node:assert/strict"
import { hostCallInputs } from "../electron/contracts/host-call-inputs.js"
import { hostCallReplay } from "../electron/contracts/host-call-policy.js"

assert.deepEqual(
  hostCallInputs["mako:thread-page"].parse(["/real/session", undefined, 100]),
  ["/real/session", undefined, 100]
)
assert.deepEqual(hostCallInputs["mako:open-tab"].parse([]), [])
assert.deepEqual(hostCallInputs["mako:account-select"].parse(["codex", null]), [
  "codex",
  null,
])
assert.throws(() =>
  hostCallInputs["mako:thread-page"].parse(["/real/session", "100"])
)
assert.throws(() => hostCallInputs["mako:open-tab"].parse([{ cwd: 42 }]))
assert.throws(() =>
  hostCallInputs["mako:mcp-sync-preview"].parse([
    "server",
    { provider: "claude", account: "default", scope: "arbitrary" },
  ])
)
assert.throws(() => hostCallInputs["mako:browser-control-connect"].parse([]))
assert.throws(() => hostCallInputs["mako:boot"].parse(["extra"]))
for (const action of ["fetch", "pull", "merge", "continue", "abort"]) {
  assert.deepEqual(hostCallInputs["mako:git-remote"].parse([{ cwd: "/repo", branch: "main", head: "a".repeat(40), action }]), [{ cwd: "/repo", branch: "main", head: "a".repeat(40), action }])
}
assert.throws(() => hostCallInputs["mako:git-remote"].parse([{ cwd: "/repo", branch: "main", action: "force-push" }]))
assert.equal(hostCallReplay("mako:git-remote"), "never", "Git writes must not be replayed after a disconnect")
console.log(
  "Host arguments: optional slots and null preserved; wrong primitive, missing argument, extra argument and invalid nested variant rejected before dispatch"
)

const queuedSteer = { kind: "steer-queued", id: "action", requestId: "running", queuedRequestId: "queued", text: "Keep this once", attachments: [] }
assert.deepEqual(hostCallInputs["mako:live-action"].parse(["conversation", queuedSteer]), ["conversation", queuedSteer])
assert.throws(() => hostCallInputs["mako:live-action"].parse(["conversation", { ...queuedSteer, queuedRequestId: undefined }]))
assert.deepEqual(hostCallInputs["mako:live-steer-queued"].parse(["conversation", queuedSteer]), ["conversation", queuedSteer])
assert.throws(() => hostCallInputs["mako:live-steer-queued"].parse(["conversation", { ...queuedSteer, kind: "steer" }]))
assert.equal(hostCallReplay("mako:live-steer-queued"), "replay", "queued steering retains its durable action id across a reconnect")

const { createMakoBridge } = await import("../electron/contracts/renderer-bridge.js")
const routed: string[] = []
const bridge = createMakoBridge({
  invoke: async (channel) => { routed.push(channel); throw Error("routing probe") },
  onEvent: () => () => {}, onTerminalEvent: () => () => {},
  pathForFile: () => null, resolveFileUrl: (url) => url,
})
const action = { ...queuedSteer, kind: "steer-queued" as const }
await assert.rejects(bridge.liveAction("conversation", action), /routing probe/)
await assert.rejects(bridge.liveAction("conversation", { ...action, kind: "steer" }), /routing probe/)
assert.deepEqual(routed, ["mako:live-steer-queued", "mako:live-action"], "web and desktop advertise queued steering separately while preserving ordinary steering")
