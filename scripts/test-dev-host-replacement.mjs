import assert from "node:assert/strict"
import { replaceDevHost } from "../electron/dev-host-replacement.mjs"

const old = { instanceId: "old", devBuild: "old-checkout" }
const fresh = { instanceId: "new", devBuild: "current-checkout" }
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
      command: async (command) => { commands.push(command) },
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
  await assert.rejects(replaceDevHost(test.input), /still finishing work/)
  assert.deepEqual(test.commands, [{ kind: "wait", action: "quit" }, { kind: "cancel" }])
  assert.equal(test.starts, 0, "A busy host must not get a competing replacement")
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
