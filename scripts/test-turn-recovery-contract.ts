import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { providerHost } from "../electron/providers/index.ts"
import { codexLiveDriver } from "../electron/providers/codex/live-driver.ts"
import { validateLiveDriver } from "../electron/providers/live-driver.ts"

// Every harness Mako installs says how a turn survives its process dying and
// names the tests that kill the process mid-turn. Those tests exist and an npm
// script runs each, so a new harness cannot register the promise without them.
const scripts = Object.values<string>(JSON.parse(readFileSync("package.json", "utf8")).scripts).join("\n")
const drivers = providerHost.liveDrivers.list()
assert.deepEqual(drivers.map((driver) => driver.provider).sort(), ["claude", "codex", "cursor", "devin", "grok", "opencode"])
for (const driver of drivers) {
  const recovery = driver.turnRecovery
  if (recovery.kind === "manual") continue
  for (const test of recovery.tests) {
    assert.ok(existsSync(test), `${driver.provider}: ${test} does not exist`)
    assert.ok(scripts.includes(test), `${driver.provider}: no npm script runs ${test}`)
  }
}

assert.throws(() => validateLiveDriver({ ...codexLiveDriver, turnRecovery: undefined }), /how a turn survives its process dying/,
  "registration rejects a harness that does not say how a turn survives its process dying")
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, turnRecovery: { kind: "continues", accepted: "On echo", exit: " ", tests: ["x"] } }), /tests that prove both/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, turnRecovery: { kind: "continues", accepted: "On echo", exit: "One update", tests: [] } }), /tests that prove both/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, canResume: false }), /needs canResume/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, turnRecovery: { kind: "manual", reason: " " } }), /or why it cannot/)

console.log(`Turn recovery: ${drivers.length} harnesses declare their receipt and process-death reporting, with tests that exist and run`)
