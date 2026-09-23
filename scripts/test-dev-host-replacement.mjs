import assert from "node:assert/strict"
import { replaceDevHost } from "../electron/dev-host-replacement.mjs"

const old = { instanceId: "old", devBuild: "old-checkout" }
const fresh = { instanceId: "new", devBuild: "current-checkout" }
const waiting = { operation: { kind: "waiting", action: "quit" }, work: [{ id: "queued-id", provider: "cursor", title: "Pending follow-up", status: "queued" }] }
function fixture(states) {
  const commands = []
  let starts = 0
  let time = 0
  return {
    commands,
    get starts() { return starts },
    input: {
      original: old,
      probe: async () => states.length > 1 ? states.shift() : states[0],
      command: async (command) => { commands.push(command); return waiting },
      readState: async () => waiting,
      start: async () => { starts++; return { info: fresh } },
      compatible: (info) => info.devBuild === fresh.devBuild,
      sleep: async (ms) => { time += ms },
      now: () => time,
      timeoutMs: 500,
    },
  }
}
{
  const test = fixture([{ state: "ready", info: old }, { state: "closing" }, { state: "absent" }])
  assert.deepEqual(await replaceDevHost(test.input), { info: fresh })
  assert.deepEqual(test.commands, [{ kind: "wait", action: "quit" }])
  assert.equal(test.starts, 1, "Only start from the requested checkout after the old host leaves")
}
{
  const test = fixture([{ state: "ready", info: old }])
  await assert.rejects(replaceDevHost(test.input), /cursor: Pending follow-up \(queued, queued-id\)/)
  assert.deepEqual(test.commands, [{ kind: "wait", action: "quit" }, { kind: "cancel" }])
  assert.equal(test.starts, 0, "A busy host must not get a competing replacement")
}
{
  const test = fixture([{ state: "ready", info: old }])
  test.input.readState = async () => ({ operation: { kind: "error", action: "quit", message: "A window did not save its draft" }, work: [] })
  await assert.rejects(replaceDevHost(test.input), /A window did not save its draft/)
  assert.equal(test.commands.length, 1, "Preserve the real shutdown error instead of cancelling and blaming agents")
}
{
  const test = fixture([{ state: "ready", info: old }])
  test.input.readState = async () => ({ operation: { kind: "idle" }, work: [] })
  await assert.rejects(replaceDevHost(test.input), /cancelled in another Mako client/)
  assert.equal(test.commands.length, 1)
}
{
  const test = fixture([{ state: "ready", info: old }])
  test.input.readState = async () => ({ operation: { kind: "applying", action: "quit" }, work: [] })
  await assert.rejects(replaceDevHost(test.input), /no active agents/)
  assert.equal(test.commands.length, 1, "Applying shutdown cannot be cancelled")
}
{
  const test = fixture([{ state: "ready", info: fresh }])
  assert.deepEqual(await replaceDevHost(test.input), { info: fresh })
  assert.equal(test.starts, 0, "Reuse a compatible concurrent replacement")
}
{
  const test = fixture([{ state: "ready", info: { ...old, instanceId: "other" } }])
  await assert.rejects(replaceDevHost(test.input), /Another Mako build/)
  assert.equal(test.starts, 0)
  assert.equal(test.commands.length, 1, "Never quit a different host that took over")
}
{
  const test = fixture([{ state: "absent" }])
  test.input.start = async () => ({ info: old })
  await assert.rejects(replaceDevHost(test.input), /Another launcher/)
}
console.log("Dev host replacement: checkout handoff, busy-host cancellation, and concurrent launcher ownership verified")
