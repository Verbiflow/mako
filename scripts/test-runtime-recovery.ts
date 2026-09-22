import assert from "node:assert/strict"
import { hostCallInputs } from "../electron/contracts/host-call-inputs.ts"
import { RuntimeDisconnectedError } from "../electron/runtime-connection.ts"
import { invokeWithRecovery, recoverableHostCalls, type RecoveryLink } from "../electron/runtime-retry.ts"
import { hostCallReplay, readOnlyHostCalls, replayableHostCalls } from "../electron/contracts/host-call-policy.ts"
import { RuntimeCallSchema } from "../electron/contracts/runtime.ts"
import { HOST_CALL_UNCONFIRMED_MESSAGE, HOST_RECONNECTING_MESSAGE, isHostReconnectingError } from "../electron/contracts/host-connection.ts"
import { daemonIsForeign } from "../electron/daemon-vintage.ts"
import { PROTOCOL_VERSION } from "@mako/sessions"

async function rejection<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error("Rejected with something other than an Error")
  }
  throw new Error("Expected a rejection")
}

// Every recoverable channel is a real handler. Reads repeat freely; the
// mutations that repeat are exactly those the host settles by a caller-minted
// id or whose repeat reaches the same end state; anything else is never
// repeated blindly.
for (const channel of recoverableHostCalls) assert.ok(channel in hostCallInputs, `${channel} is not a host channel`)
for (const channel of replayableHostCalls) assert.ok(channel in hostCallInputs, `${channel} is not a host channel`)
for (const mutation of ["mako:git-stage", "mako:git-commit", "mako:git-push", "mako:prompt", "mako:set-cwd", "mako:lifecycle-command", "mako:install-update", "mako:thread-run", "mako:terminal-write"]) {
  assert.ok(!recoverableHostCalls.has(mutation), `${mutation} must never be repeated blindly`)
  assert.equal(hostCallReplay(mutation), "never")
}
for (const settled of ["mako:live-prompt", "mako:live-start", "mako:live-transfer", "mako:live-fork", "mako:native-submit", "mako:live-cancel", "mako:thread-remember-mode"])
  assert.equal(hostCallReplay(settled), "replay", `${settled} is settled by its id`)
assert.equal(hostCallReplay("mako:git-status"), "read")
assert.ok(readOnlyHostCalls.has("mako:git-status"))
assert.ok(!readOnlyHostCalls.has("mako:live-prompt"))

// An id-settled mutation that drops mid-call is re-issued as attempt 2 once
// the host is back; the host answers the repeated id with its first acceptance.
{
  const { value, calls } = link(10)
  const attempts: number[] = []
  const result = await invokeWithRecovery("mako:live-prompt", async (attempt) => {
    attempts.push(attempt)
    if (attempt === 1) throw new RuntimeDisconnectedError(true)
    return { accepted: true }
  }, value, 500)
  assert.deepEqual(result, { accepted: true })
  assert.deepEqual(attempts, [1, 2])
  assert.deepEqual(calls, ["lost", "wait:500"])
}
// The wire carries the attempt only on a repeat, and bounds it.
assert.equal(RuntimeCallSchema.parse({ channel: "mako:live-prompt", args: [] }).attempt, undefined)
assert.equal(RuntimeCallSchema.parse({ channel: "mako:live-prompt", args: [], attempt: 2 }).attempt, 2)
assert.throws(() => RuntimeCallSchema.parse({ channel: "mako:live-prompt", args: [], attempt: 0 }))
assert.throws(() => RuntimeCallSchema.parse({ channel: "mako:live-prompt", args: [], attempt: 9 }))

function link(reconnectAfterMs: number | null) {
  const calls: string[] = []
  const value: RecoveryLink = {
    lost: () => { calls.push("lost") },
    whenConnected: (timeoutMs) => new Promise((resolve) => {
      calls.push(`wait:${timeoutMs}`)
      if (reconnectAfterMs === null) { setTimeout(() => resolve(false), timeoutMs); return }
      setTimeout(() => resolve(true), reconnectAfterMs)
    }),
  }
  return { value, calls }
}

// A read that drops mid-call runs again once the stream reattaches.
{
  const { value, calls } = link(10)
  let attempts = 0
  const result = await invokeWithRecovery("mako:git-status", async () => {
    attempts += 1
    if (attempts === 1) throw new RuntimeDisconnectedError(true)
    return { files: [] }
  }, value, 500)
  assert.deepEqual(result, { files: [] })
  assert.equal(attempts, 2)
  assert.deepEqual(calls, ["lost", "wait:500"])
}

// A mutation is never repeated; the caller hears that its outcome is unknown.
{
  const { value, calls } = link(10)
  let attempts = 0
  const failure = await rejection(invokeWithRecovery("mako:git-commit", async () => {
    attempts += 1
    throw new RuntimeDisconnectedError(true)
  }, value, 500))
  assert.ok(failure instanceof RuntimeDisconnectedError && failure.unconfirmed)
  assert.equal(failure.message, HOST_CALL_UNCONFIRMED_MESSAGE)
  assert.equal(attempts, 1)
  assert.deepEqual(calls, ["lost"], "the window still learns the host is gone")
}

// A refused connection never dispatched anything, so the plain wording is used.
assert.equal(new RuntimeDisconnectedError(false).message, HOST_RECONNECTING_MESSAGE)
assert.ok(isHostReconnectingError(new Error(`Error invoking remote method 'mako:git-status': Error: ${HOST_CALL_UNCONFIRMED_MESSAGE}`)))
assert.ok(!isHostReconnectingError(new Error("socket hang up")), "raw socket errors are not the host's own wording")

// No reconnect within the deadline: the original error surfaces, once.
{
  const { value } = link(null)
  let attempts = 0
  await assert.rejects(invokeWithRecovery("mako:git-status", async () => {
    attempts += 1
    throw new RuntimeDisconnectedError(false)
  }, value, 20), RuntimeDisconnectedError)
  assert.equal(attempts, 1)
}

// Ordinary handler errors pass straight through and never mark the host lost.
{
  const { value, calls } = link(10)
  await assert.rejects(invokeWithRecovery("mako:git-status", async () => { throw new Error("This folder is not a Git repository") }, value, 500), /not a Git repository/)
  assert.deepEqual(calls, [])
}

// Daemon vintage: same protocol and script is ours; anything else is foreign.
const script = "/Applications/Mako.app/Contents/Resources/app.asar/node_modules/@mako/sessions/dist/daemon-main.js"
assert.equal(daemonIsForeign({ version: PROTOCOL_VERSION, script }, script), false)
assert.equal(daemonIsForeign({ version: PROTOCOL_VERSION }, script), false, "a daemon too old to report its script is judged by protocol alone")
assert.equal(daemonIsForeign({ version: PROTOCOL_VERSION, script: "/Users/someone/pi-ui/node_modules/@mako/sessions/dist/daemon-main.js" }, script), true)
assert.equal(daemonIsForeign({ version: PROTOCOL_VERSION - 1, script }, script), true)
assert.equal(daemonIsForeign({ version: PROTOCOL_VERSION + 1, script }, script), true)

console.log("Runtime recovery: reads and id-settled mutations repeat after reconnect as attempt 2, other mutations never do, refused and dropped calls are told apart, and foreign daemons are recognised")

{
  const { value, calls } = link(10)
  const error = await rejection(invokeWithRecovery("mako:live-continue", async () => {
    throw new RuntimeDisconnectedError(true, "peer-conversation")
  }, value))
  assert.ok(error instanceof RuntimeDisconnectedError && error.conversationId === "peer-conversation")
  assert.deepEqual(calls, [], "a peer outage does not disconnect the receiving desktop host")
}

{
  const { value } = link(1)
  let attempts = 0
  const error = await rejection(invokeWithRecovery("mako:live-prompt", async () => {
    if (++attempts === 1) throw new RuntimeDisconnectedError(true)
    throw new Error("Owner lookup failed after reconnect")
  }, value))
  assert.ok(error instanceof RuntimeDisconnectedError && error.unconfirmed,
    "a generic retry failure preserves the first mutation's unknown outcome")
}
