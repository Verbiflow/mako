import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { devinResumePolicy } from "../electron/providers/devin/resume.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { grokCheckpoint } from "../electron/providers/grok/fork.ts"
import { grokSessionSource } from "../electron/providers/grok/session-source.ts"
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
const noResume = { kind: "unavailable", reason: "Fixture sessions can't be reopened" } as const
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, resume: noResume }), /needs native resume/,
  "a turn continued after its process died needs a session that reopens")
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, resume: noResume, turnRecovery: { kind: "manual", reason: "Fixture" }, fork: { kind: "import", via: "Fixture import" } }), /needs native resume/,
  "a fork Mako imports continues as a resumed session")
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, modeSwitching: { kind: "native", via: "Fixture" }, modes: codexLiveDriver.modes?.slice(0, 1) }), /mode switching is native with 1 mode/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, modeSwitching: { kind: "single", reason: "Fixture" } }), /mode switching is single/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, questions: { kind: "request", via: "Fixture" }, approvalEvidence: { kind: "no-interactive-requests", reason: "Fixture" }, modes: [], modeSwitching: { kind: "single", reason: "Fixture" } }), /need interactive requests/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, nativeAgents: { kind: "not-built", reason: " " } }), /explain its subagents declaration/)
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, turnRecovery: { kind: "manual", reason: " " } }), /or why it cannot/)

// A resumable ACP source locates its own sessions (its type requires it): the
// host resumes only a located one, and the thread list finds a new session
// only after indexing it.
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
  const env = {}
  assert.equal(devin.locate({ nativeId: "aloud-lint", env }), `${join(devinStore, "sessions.db")}#aloud-lint`)
  assert.equal(devin.locate({ nativeId: "hidden-one", env }), undefined)
  assert.equal(devin.locate({ nativeId: "missing", env }), undefined)
  const accountData = join(stores, "account-data")
  mkdirSync(join(accountData, "devin"), { recursive: true })
  symlinkSync(devinStore, join(accountData, "devin", "cli"))
  assert.equal(devinResumePolicy().locate({ nativeId: "aloud-lint", env: { XDG_DATA_HOME: accountData } }), `${join(accountData, "devin", "cli", "sessions.db")}#aloud-lint`,
    "a Devin account's session is found through that account's data folder")
  const grokHome = join(stores, "grok-home")
  mkdirSync(join(grokHome, "sessions", encodeURIComponent("/private/var/work"), grokId), { recursive: true })
  writeFileSync(join(grokHome, "sessions", encodeURIComponent("/private/var/work"), grokId, "updates.jsonl"), "")
  assert.equal(grokAcpSource.resume.kind === "native" ? grokAcpSource.resume.locate({ nativeId: grokId, cwd: "/var/work", env: { GROK_HOME: grokHome } }) : undefined,
    join(grokHome, "sessions", encodeURIComponent("/private/var/work"), grokId, "updates.jsonl"), "Grok's sessions are found under the GROK_HOME it runs with")

  // Grok's fork target from its recorded stores: a rewind keeps the turns before it, and a steered message isn't a turn.
  const pairs = "scripts/fixtures/native-decoding/grok/pairs"
  for (const [pair, expected] of [["todos-over-two-turns", "1"], ["rewound-turn", "1"], ["steered-shell", "0"]] as const) {
    const sessions = join(pairs, pair, "home", ".grok", "sessions")
    const [workspace] = readdirSync(sessions)
    const [nativeId] = readdirSync(join(sessions, workspace!))
    assert.equal(grokCheckpoint({ nativeId: nativeId!, env: { GROK_HOME: join(pairs, pair, "home", ".grok") }, cwd: decodeURIComponent(workspace!) }), expected,
      `${pair}: the checkpoint is Grok's count of the turns its fork keeps`)
  }
  const growingHome = join(stores, "grok-growing")
  const growing = join(growingHome, "sessions", encodeURIComponent("/work"), grokId)
  mkdirSync(growing, { recursive: true })
  const prompt = (index: number) => JSON.stringify({ method: "session/update", params: { sessionId: grokId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: `turn ${index}` }, _meta: { promptIndex: index } } } })
  const ended = JSON.stringify({ method: "_x.ai/session/update", params: { sessionId: grokId, update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" } } })
  const at = { nativeId: grokId, env: { GROK_HOME: growingHome }, cwd: "/work" }
  writeFileSync(join(growing, "updates.jsonl"), `${prompt(0)}\n${ended}\n`)
  assert.equal(grokCheckpoint(at), "0")
  appendFileSync(join(growing, "updates.jsonl"), `${prompt(1)}\n${ended}\n${prompt(2).slice(0, 40)}`)
  assert.equal(grokCheckpoint(at), "1", "a line still being written waits for its end")
  appendFileSync(join(growing, "updates.jsonl"), `${prompt(2).slice(40)}\n`)
  assert.equal(grokCheckpoint(at), "2", "the next read starts where the last one stopped")
  writeFileSync(join(growing, "updates.jsonl"), `${prompt(0)}\n`)
  assert.equal(grokCheckpoint(at), "0", "a file that shrank is read again from the start")
} finally {
  rmSync(stores, { recursive: true, force: true })
}

console.log(`Turn recovery: ${drivers.length} harnesses declare their receipt and process-death reporting, with tests that exist and run`)
