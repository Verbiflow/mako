import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { acpLiveDriver } from "../electron/providers/acp-live-driver.ts"
import { devinResumePolicy } from "../electron/providers/devin/resume.ts"
import { grokAcpSource, grokSessionSource } from "../electron/providers/grok/acp.ts"
import { providerHost } from "../electron/providers/index.ts"
import { codexLiveDriver } from "../electron/providers/codex/live-driver.ts"
import { validateLiveDriver, type ProviderLiveDriver } from "../electron/providers/live-driver.ts"

function codexWithout(declaration: keyof ProviderLiveDriver): ProviderLiveDriver {
  // SAFETY: deliberately malformed input: a declaration the type requires is removed, to prove registration rejects it at runtime.
  return { ...codexLiveDriver, [declaration]: undefined } as ProviderLiveDriver
}

// Every harness Mako installs says how a turn survives its process dying and
// names the tests that kill the process mid-turn. Those tests exist and an npm
// script runs each, so a new harness cannot register the promise without them.
const scripts = Object.values<string>(JSON.parse(readFileSync("package.json", "utf8")).scripts).join("\n")
const drivers = providerHost.liveDrivers.list()
assert.deepEqual(drivers.map((driver) => driver.provider).sort(), registeredHarnessIds().sort())
for (const driver of drivers) {
  const recovery = driver.turnRecovery
  if (recovery.kind === "manual") continue
  for (const test of recovery.tests) {
    assert.ok(existsSync(test), `${driver.provider}: ${test} does not exist`)
    assert.ok(scripts.includes(test), `${driver.provider}: no npm script runs ${test}`)
  }
}

assert.throws(() => validateLiveDriver(codexWithout("turnRecovery")), /how a turn survives its process dying/,
  "registration rejects a harness that does not say how a turn survives its process dying")
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, turnRecovery: { kind: "continues", accepted: "On echo", exit: " ", tests: ["x"] } }), /tests that prove both/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, turnRecovery: { kind: "continues", accepted: "On echo", exit: "One update", tests: [] } }), /tests that prove both/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, canResume: false }), /needs canResume/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, inspectNativeSession: undefined }), /explicit checkpoint and session evidence/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, checkpoint: undefined }), /explicit checkpoint and session evidence/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, turnRecovery: { kind: "manual", reason: " " } }), /or why it cannot/)

// A resumable ACP source locates its own sessions: the host resumes only a
// located one, and the thread list finds a new session only after indexing it.
assert.throws(() => acpLiveDriver({ ...grokAcpSource, locateSession: undefined }), /must locate its sessions/)
const stores = mkdtempSync(join(tmpdir(), "mako-session-locate-"))
try {
  const grokRoot = join(stores, "grok")
  const grokId = "01a0831d-c199-70d0-b2f0-d7b9835a66d5"
  mkdirSync(join(grokRoot, encodeURIComponent("/private/var/work"), grokId), { recursive: true })
  writeFileSync(join(grokRoot, encodeURIComponent("/private/var/work"), grokId, "updates.jsonl"), "")
  assert.equal(grokSessionSource(grokId, "/var/work", grokRoot), join(grokRoot, encodeURIComponent("/private/var/work"), grokId, "updates.jsonl"),
    "a session is found under another spelling of its launch directory")
  assert.equal(grokSessionSource("01a0831d-0000-0000-0000-000000000000", "/var/work", grokRoot), undefined)
  assert.equal(grokSessionSource("../escape", "/var/work", grokRoot), undefined)
  const devinStore = join(stores, "devin")
  mkdirSync(devinStore)
  const database = new DatabaseSync(join(devinStore, "sessions.db"))
  database.exec("CREATE TABLE sessions (id TEXT, hidden INTEGER, main_chain_id INTEGER, model TEXT, working_directory TEXT)")
  database.prepare("INSERT INTO sessions VALUES (?, ?, NULL, NULL, '/work')").run("aloud-lint", 0)
  database.prepare("INSERT INTO sessions VALUES (?, ?, NULL, NULL, '/work')").run("hidden-one", 1)
  database.close()
  const devin = devinResumePolicy(devinStore)
  assert.equal(devin.locateSession({ nativeId: "aloud-lint" }), `${join(devinStore, "sessions.db")}#aloud-lint`)
  assert.equal(devin.locateSession({ nativeId: "hidden-one" }), undefined)
  assert.equal(devin.locateSession({ nativeId: "missing" }), undefined)
} finally {
  rmSync(stores, { recursive: true, force: true })
}

console.log(`Turn recovery: ${drivers.length} harnesses declare their receipt and process-death reporting, with tests that exist and run`)
