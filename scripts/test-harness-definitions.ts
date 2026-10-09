import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readableHarnesses } from "@mako/sessions"
import { createProviderHost, type ProviderHost } from "../electron/providers/host.ts"
import {
  installHarness,
  lacks,
  unlistedOwnDeclarations,
  type HarnessDefinition,
  type HarnessFamily,
} from "../electron/providers/harness-definition.ts"
import { providerHost } from "../electron/providers/index.ts"
import { capabilityText, harnessLacks, liveCapabilities, LIVE_CAPABILITY_KEYS } from "../electron/providers/live-capabilities.ts"
import { HARNESS_USAGE_KEYS } from "../electron/contracts/harness-usage.ts"
import type { ProviderRegistry, ProviderCapability } from "../electron/providers/registry.ts"
import { GENERATED_PATH, renderHarnessDescriptors } from "./harness-descriptors.ts"
import { GENERATED_PATH as CHECKLIST_PATH, missingSteps, renderHarnessChecklist } from "./harness-checklist.ts"

/**
 * A harness is one definition that names every capability family. These
 * checks hold every installed harness to that, so a family a harness skipped
 * fails here rather than going missing in some screen.
 */

const families = {
  hooks: "hooks",
  commands: "commands",
  toolEditing: "toolEditing",
  skillEditing: "skillEditing",
  mcpEditing: "mcpEditing",
  live: "liveDrivers",
  decoder: "decoders",
  profile: "profiles",
  accounts: "accountCapabilities",
  acp: "acpSources",
  nativeRunner: "nativeRunners",
  processProbe: "processProbes",
  mcp: "mcpSources",
  skills: "skillSources",
  sessionEmitter: "sessionEmitters",
  connection: "connections",
  updates: "updateSources",
  usageHistory: "usageHistories",
  artifactPreview: "artifactPreviews",
} as const satisfies Record<HarnessFamily, Exclude<keyof ProviderHost, "harnesses">>

// SAFETY: `families` satisfies a record over exactly the HarnessFamily keys.
const familyNames = Object.keys(families) as HarnessFamily[]

type CapabilityLookup = Pick<ProviderRegistry<ProviderCapability>, "list" | "get">
const registry = (family: HarnessFamily): CapabilityLookup => providerHost[families[family]]

const harnesses = providerHost.harnesses.list()
assert.equal(readFileSync(GENERATED_PATH, "utf8"), renderHarnessDescriptors(), "src/dev/harness-descriptors.ts is behind the definitions; run npm run harness:descriptors")
assert.deepEqual(new Set(readableHarnesses()), new Set(harnesses.map((entry) => entry.provider)), "every installed harness has a saved-history reader in @mako/sessions, and every reader a harness")
assert.ok(harnesses.length > 0)
assert.equal(new Set(harnesses.map((entry) => entry.provider)).size, harnesses.length)

for (const family of familyNames) {
  for (const capability of registry(family).list()) {
    assert.ok(
      providerHost.harnesses.get(capability.provider),
      `${capability.provider}'s ${family} is registered outside a harness definition`
    )
  }
}

const matrix: string[] = []
for (const { provider, absent } of harnesses) {
  const row: string[] = []
  for (const family of familyNames) {
    const present = registry(family).get(provider) !== undefined
    const reason = absent[family]
    assert.notEqual(present, reason !== undefined, `${provider} must give its ${family} or say why it has none`)
    if (reason) assert.ok(reason.reason.length > 0, `${provider} says why it has no ${family}`)
    row.push(present ? "yes" : reason?.absent === "mako" ? "gap" : "-")
  }
  matrix.push(`${provider.padEnd(9)} ${row.map((cell, index) => cell.padEnd(familyNames[index]!.length + 1)).join("")}`)
  assert.ok(readableHarnesses().includes(provider), `${provider} has a saved-history reader in @mako/sessions`)
  assert.ok(registry("live").get(provider), `${provider} has a live driver`)
  const runner = providerHost.nativeRunners.get(provider)
  if (runner) {
    assert.ok(runner.transport.trim(), `${provider} declares its actual headless transport`)
    assert.ok(runner.launchCredentials.kind === "resolved" || runner.launchCredentials.reason.trim(), `${provider} declares credential resolution or explains its absence`)
  }
}

// Every harness decodes its native messages through a declared decoder with
// recorded sessions to replay.
for (const harness of harnesses) {
  assert.equal(harness.absent.decoder, undefined, `${harness.provider} decodes through a declared decoder, not inside its driver`)
  const fixtures = join(import.meta.dirname, "fixtures", "native-decoding", harness.provider)
  assert.ok(existsSync(fixtures) && readdirSync(fixtures).some((name) => name.endsWith(".json")), `${harness.provider} has decoding fixtures in ${fixtures}`)
}

const host = createProviderHost()
const definition: HarnessDefinition = {
  provider: "example",
  presentation: { mark: { viewBox: "0 0 24 24", paths: [{ d: "M0 0h24v24H0z" }], tint: "currentColor" } },
  diagnostics: {},
  usage: { ...providerHost.harnesses.get("codex")!.usage, resetCredits: harnessLacks("test") },
  hooks: lacks("test"),
  commands: lacks("test"),
  toolEditing: lacks("test"),
  skillEditing: lacks("test"),
  mcpEditing: lacks("test"),
  live: providerHost.liveDrivers.get("codex")!,
  decoder: lacks("test"),
  profile: providerHost.profiles.get("codex")!,
  accounts: lacks("test"),
  acp: lacks("test"),
  nativeRunner: lacks("test"),
  processProbe: lacks("test"),
  mcp: lacks("test"),
  skills: lacks("test"),
  sessionEmitter: lacks("test"),
  connection: lacks("test"),
  updates: lacks("test"),
  usageHistory: lacks("test"),
  artifactPreview: lacks("test"),
  unique: [],
}
assert.throws(() => installHarness(host, definition), /example's live capability is filed under codex/)
assert.throws(() => installHarness(host, { ...definition, diagnostics: { runsInSdk: true } }), /runs in an SDK it does not name/)
assert.equal(host.harnesses.list().length, 0)
assert.equal(host.hooks.list().length, 0)

assert.throws(() => installHarness(host, {
  ...definition,
  live: { ...definition.live, provider: "example", resume: { kind: "not-built", reason: "test" } },
  profile: { ...definition.profile, provider: "example" },
}), /continued on its native session, which needs native resume/)
assert.equal(host.harnesses.list().length, 0, "a turn recovery without native resume cannot install a partial harness")
assert.equal(host.liveDrivers.list().length, 0)

const nativeRunner = providerHost.nativeRunners.get("codex")!
for (const invalid of [
  { ...nativeRunner, provider: "example", transport: "" },
  { ...nativeRunner, provider: "example", launchCredentials: { kind: "unavailable" as const, reason: "" } },
]) {
  assert.throws(() => installHarness(host, {
    ...definition,
    live: { ...definition.live, provider: "example" },
    profile: { ...definition.profile, provider: "example" },
    nativeRunner: invalid,
  }), /must declare.*headless/)
  assert.equal(host.harnesses.list().length, 0)
  assert.equal(host.liveDrivers.list().length, 0, "invalid headless declarations cannot leave a partially installed harness")
}

for (const field of ["launchEnvironment", "nativeIdentity", "nativeExclusion", "nativePromptIdentity"] as const) {
  assert.throws(() => installHarness(host, {
    ...definition,
    live: { ...definition.live, provider: "example", [field]: undefined },
    profile: { ...definition.profile, provider: "example" },
  }), Error, `a new harness must declare ${field}, including why it is unavailable`)
  assert.equal(host.harnesses.list().length, 0)
  assert.equal(host.liveDrivers.list().length, 0)
}

// A driver whose fields contradict each other never installs. Each field
// carries its own hooks, so only invariants across fields are checked here.
const example = { ...definition, live: { ...definition.live, provider: "example" }, profile: { ...definition.profile, provider: "example" } }
const manual = { turnRecovery: { kind: "manual", reason: "test" } } as const
for (const [harness, refusal] of [
  [{ ...example, live: { ...example.live, ...manual, resume: { kind: "unavailable", reason: "test" }, fork: { kind: "import", via: "test" } } }, /fork Mako imports continues as a resumed session/],
  [{ ...example, live: { ...example.live, fork: { kind: "import", via: "test" } } }, /forks by importing the conversation into a new session, which needs its session emitter/],
  [{ ...example, live: { ...example.live, modeSwitching: { kind: "single", reason: "test" } } }, /mode switching is single with 4 modes/],
  [{ ...example, live: { ...example.live, steering: { kind: "not-built", reason: " " } } }, /explain its steering declaration/],
  ...example.live.resume.kind === "native" ? [[{ ...example, live: { ...example.live, resume: { ...example.live.resume, wake: "" } } }, /explain its idle wake declaration/] as const] : [],
] as const) {
  assert.throws(() => installHarness(host, harness), refusal)
  assert.equal(host.harnesses.list().length, 0, "a contradicted capability cannot leave a partially installed harness")
}

// The catalog is the driver, projected: changing a field changes what the
// window shows, with the driver's words, and nothing else can disagree.
const codex = example.live
assert.deepEqual(liveCapabilities({ ...codex, steering: { kind: "not-built", reason: "test gap" } }).steering, { state: "absent", by: "mako", reason: "test gap" })
assert.deepEqual(liveCapabilities({ ...codex, contextBreakdown: { kind: "unavailable", reason: "test lack" } }).contextBreakdown, { state: "absent", by: "harness", reason: "test lack" })
const unresumable = liveCapabilities({ ...codex, ...manual, resume: { kind: "unavailable", reason: "test" } })
assert.equal(unresumable.resume.state, "absent")
assert.equal(unresumable.residency.state, "absent", "a process that can't be reopened is never closed when idle")
assert.equal(liveCapabilities(codex).residency.state, "implemented")
assert.ok(codex.resume.kind === "native" && capabilityText(liveCapabilities(codex).residency).includes(codex.resume.wake),
  "residency explains how the harness wakes, in the driver's words")

// Every installed harness states every live capability, with its words.
for (const harness of harnesses) {
  for (const key of LIVE_CAPABILITY_KEYS) {
    const capability = harness.capabilities[key]
    assert.ok(capability, `${harness.provider} declares ${key}`)
    assert.ok((capability.state === "implemented" ? capability.via : capability.reason).trim(), `${harness.provider} explains ${key}`)
  }
  for (const key of HARNESS_USAGE_KEYS)
    assert.ok(capabilityText(harness.usage[key]).trim(), `${harness.provider} says what it reports for usage ${key}, or why it reports none`)
  assert.deepEqual(harness.usage.contextBreakdown, harness.capabilities.contextBreakdown, `${harness.provider}'s context breakdown is its live driver's`)
  assert.equal(harness.usage.outsideMako.state === "implemented", !harness.absent.usageHistory, `${harness.provider}'s spend outside Mako is its usage history`)
}

// A declaration only one harness implements shows one of its own features, and its list says so.
assert.deepEqual(unlistedOwnDeclarations(harnesses), [], "a declaration only one harness implements is listed in its unique")
for (const harness of harnesses) {
  for (const { name, mako } of harness.unique)
    assert.ok(mako.state !== "implemented" || mako.field === "tools" || mako.via.length > 0, `${harness.provider}'s ${name} says where it shows`)
  assert.equal(harness.artifacts.state === "implemented", !harness.absent.artifactPreview, `${harness.provider}'s artifact previews are its artifactPreview family`)
}

// The new-harness checklist is generated from the code, and every installed harness passes its checked steps.
assert.equal(readFileSync(CHECKLIST_PATH, "utf8"), renderHarnessChecklist(), "docs/adding-a-harness.md is behind the code; run npm run harness:checklist")
for (const { provider } of harnesses) assert.deepEqual(missingSteps(provider), [], `${provider} misses steps of docs/adding-a-harness.md`)

console.log(`${"".padEnd(10)}${familyNames.join(" ")}`)
for (const line of matrix) console.log(line)
console.log("PASS: every harness names each capability family, has a live driver and a saved-history reader, and passes the generated checklist")
