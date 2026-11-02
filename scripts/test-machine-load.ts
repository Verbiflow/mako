import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { availableParallelism } from "node:os"
import { busyReasons, describeMachine, readMachine, type MachineReading } from "@mako/host/base/machine-load"

/**
 * What a performance measurement reads of the machine before it trusts a
 * timing (`@mako/host/base/machine-load`): with one process spinning on
 * every core, other work holds the machine and the reading says so; the
 * spinners gone, it drops by about as many cores as they held, where the
 * machine was quiet before them.
 *
 *   npx tsx scripts/test-machine-load.ts
 */

const cores = availableParallelism()
const before = await readMachine(1_000)
const spinners: ChildProcess[] = Array.from({ length: cores }, () => spawn(process.execPath, ["-e", "for (;;) {}"], { stdio: "ignore" }))
let loaded: MachineReading
try {
  await new Promise((resolve) => setTimeout(resolve, 300))
  loaded = await readMachine(1_500)
} finally {
  for (const spinner of spinners) spinner.kill("SIGKILL")
}
await Promise.all(spinners.map((spinner) => new Promise((resolve) => (spinner.exitCode === null && spinner.signalCode === null ? spinner.once("exit", resolve) : resolve(undefined)))))
const after = await readMachine(1_000)
console.log(`before: ${describeMachine(before)}\nloaded: ${describeMachine(loaded)}\nafter:  ${describeMachine(after)}`)

assert.equal(loaded.cores, cores)
assert.ok(loaded.othersBusy > cores * 0.8, `${cores} spinners keep most of the ${cores} cores busy (${loaded.othersBusy.toFixed(1)})`)
assert.ok(busyReasons(loaded).some((reason) => reason.startsWith("other work kept")), "and the reading calls the machine busy")
// On a machine already busy, which the updater may run this on, the spinners' cores were held anyway.
if (busyReasons(before).length === 0)
  assert.ok(after.othersBusy < loaded.othersBusy - cores * 0.4, "the spinners gone, the reading drops by about the cores they held")
else console.log("The machine was busy before the spinners started; not judging the drop after them.")
assert.ok(["normal", "warning", "critical"].includes(loaded.memory))
if (process.platform === "darwin") assert.ok(loaded.thermal !== undefined, "macOS says its thermal pressure")
assert.deepEqual(busyReasons({ cores: 14, othersBusy: 3, loadAverage: 30, memory: "normal", thermal: "nominal" }), [], "a load average alone, which counts the caller too, isn't busy")
assert.deepEqual(busyReasons({ cores: 14, othersBusy: 3, loadAverage: 3, memory: "warning", thermal: "moderate" }), ["thermal pressure was moderate", "memory pressure was warning"])
console.log("PASS: the machine's reading sees other work holding the cores, and lets go when it stops")
