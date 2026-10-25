import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readableHarnesses } from "@mako/sessions"
import { createProviderHost, type ProviderHost } from "@mako/host/harnesses/host"
import {
  installHarness,
  lacks,
  type HarnessDefinition,
  type HarnessFamily,
} from "@mako/host/harnesses/harness-definition"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { capabilityText, harnessLacks, liveCapabilities, makoLacks, LIVE_CAPABILITY_KEYS } from "@mako/host/harnesses/live-capabilities"
import { HARNESS_USAGE_KEYS } from "@mako/host/contracts/harness-usage"
import { HARNESS_FEATURE_KEYS, HARNESS_FEATURES, makosOwn, native, shownAs, TOOL_ROWS, type FeatureDeclarations } from "@mako/host/contracts/harness-features"
import type { ProviderRegistry, ProviderCapability } from "@mako/host/harnesses/registry"
import { GENERATED_PATH, renderHarnessDescriptors } from "./harness-descriptors.ts"
import { GENERATED_PATH as CHECKLIST_PATH, missingSteps, renderHarnessChecklist } from "./harness-checklist.ts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { VOCABULARIES } from "@mako/sessions/harnesses"
import { compareVersions } from "@mako/host/contracts/runtime-version"
import { z } from "zod"
import { currentPairVersions } from "./native-decoding.ts"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

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
assert.equal(readFileSync(GENERATED_PATH, "utf8"), renderHarnessDescriptors(providerHost), "src/dev/harness-descriptors.ts is behind the definitions; run npm run harness:descriptors")
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
  // A cloud machine runs the start of its Thread's harness ahead as it boots: every harness says how, or why it can't.
  const prefetch = providerHost.liveDrivers.get(provider)?.startPrefetch
  assert.ok(prefetch, `${provider} declares what its start runs first (startPrefetch)`)
  assert.ok(prefetch.via.trim(), `${provider} explains its startPrefetch`)
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
/** Mako's own where it has one, and a lack everywhere else: what a harness with none of its own declares. */
// SAFETY: the entries cover every HARNESS_FEATURE_KEYS key.
const ownless = Object.fromEntries(HARNESS_FEATURE_KEYS.map((key) =>
  [key, { mako: "mako" in HARNESS_FEATURES[key] ? makosOwn() : harnessLacks("test") }])) as FeatureDeclarations
const definition: HarnessDefinition = {
  provider: "example",
  presentation: { mark: { viewBox: "0 0 24 24", paths: [{ d: "M0 0h24v24H0z" }], tint: "currentColor" } },
  diagnostics: {},
  usage: { ...providerHost.harnesses.get("codex")!.usage, resetCredits: harnessLacks("test"), limitSwitch: harnessLacks("test") },
  hooks: lacks("test"),
  commands: lacks("test"),
  toolEditing: lacks("test"),
  skillEditing: lacks("test"),
  mcpEditing: lacks("test"),
  live: { ...providerHost.liveDrivers.get("codex")!, goals: { kind: "mako", reason: "test" }, sideQuestions: { kind: "fork", via: "test", ask: async () => "", close: async () => {} }, review: { kind: "mako", reason: "test" } },
  decoder: lacks("test"),
  profile: providerHost.profiles.get("codex")!,
  accounts: lacks("test"),
  acp: lacks("test"),
  nativeRunner: lacks("test"),
  processProbe: lacks("test"),
  mcp: lacks("test"),
  skills: lacks("test"),
  connection: lacks("test"),
  updates: lacks("test"),
  usageHistory: lacks("test"),
  artifactPreview: lacks("test"),
  features: ownless,
  unique: [],
}
assert.throws(() => installHarness(host, definition), /example's live capability is filed under codex/)

assert.deepEqual(HARNESS_FEATURE_KEYS, Object.keys(HARNESS_FEATURES), "the feature list is the catalog, in its order")
// Shared features are declared under Mako's names, and a declaration the
// rest of the definition contradicts never installs.
const { features: _features, ...featureless } = definition
const { goals: _goals, ...goalless } = ownless
// SAFETY: each is a definition the types refuse, as a JavaScript harness could still send it.
assert.throws(() => installHarness(host, featureless as HarnessDefinition), /doesn't say what it calls Mako's shared features/)
// SAFETY: as above.
assert.throws(() => installHarness(host, { ...definition, features: goalless as FeatureDeclarations }), /declares nothing for Goals/)
for (const [features, refusal] of [
  [{ ...ownless, worktrees: { mako: harnessLacks("test") } }, /says it lacks Worktrees, but Mako's own serves every harness/],
  [{ ...ownless, goals: { mako: shownAs("test") } }, /shows its own Goals without naming it/],
  [{ ...ownless, goals: { native: native(" ", "test"), mako: harnessLacks("test") } }, /must say what it calls Goals and where it has it/],
  [{ ...ownless, review: { mako: TOOL_ROWS } }, /shows Code review in tool rows, but no kind of tool carries it/],
  [{ ...ownless, webSearch: { mako: TOOL_ROWS } }, /shows Web search in tool rows, but its vocabulary has no web-search tool/],
  [{ ...ownless, sideQuestions: { mako: harnessLacks(" ") } }, /must explain where Side questions stands/],
] satisfies [FeatureDeclarations, RegExp][]) {
  assert.throws(() => installHarness(host, { ...definition, features }), refusal)
}
assert.throws(() => installHarness(host, { ...definition, provider: "codex", features: { ...ownless, webSearch: { mako: harnessLacks("test") } } }),
  /says it lacks Web search, but its vocabulary offers `web_search`/)
assert.throws(() => installHarness(host, { ...definition, live: { ...definition.live, provider: "example" }, profile: { ...definition.profile, provider: "example" }, unique: [{ name: "Goals", native: "test", mako: harnessLacks("test") }] }),
  /lists Goals as its own, but it's Mako's shared Goals/)
assert.throws(() => installHarness(host, { ...definition, live: { ...definition.live, provider: "example" }, profile: { ...definition.profile, provider: "example" }, unique: [{ name: "Fork", native: "test", mako: harnessLacks("test") }] }),
  /lists Fork as its own, but it's the shared capability Fork/)
assert.throws(() => installHarness(host, { ...definition, diagnostics: { runsInSdk: true } }), /runs in an SDK it does not name/)
// The goal bar drives whichever goal the driver keeps, so the catalog row must say the same.
const examples = { live: { ...definition.live, provider: "example" }, profile: { ...definition.profile, provider: "example" } }
assert.throws(() => installHarness(host, { ...definition, ...examples, live: { ...examples.live, review: providerHost.liveDrivers.get("codex")!.review } }),
  /example declares its review as mako, but its live driver starts the harness's own review/)
assert.throws(() => installHarness(host, { ...definition, ...examples, live: { ...examples.live, goals: providerHost.liveDrivers.get("codex")!.goals } }),
  /example declares its goals as mako, but its live driver keeps them natively/)
assert.throws(() => installHarness(host, { ...definition, ...examples, features: { ...ownless, goals: { native: native("/goal", "test"), mako: shownAs("test") } } }),
  /example declares its goals as harness, but its live driver keeps them in Mako's loop/)
// The side panel asks whoever the driver asks, so the catalog row must say the same.
assert.throws(() => installHarness(host, { ...definition, ...examples, live: { ...examples.live, sideQuestions: providerHost.liveDrivers.get("codex")!.sideQuestions } }),
  /example declares its side questions as mako, but its live driver answers them natively/)
assert.throws(() => installHarness(host, { ...definition, ...examples, features: { ...ownless, sideQuestions: { mako: makoLacks("test") } } }),
  /example declares its side questions as absent, but its live driver answers them from a copy of the session/)
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

// Every harness says what it calls each shared feature and where Mako stands on it.
for (const harness of harnesses) {
  for (const key of HARNESS_FEATURE_KEYS) {
    const { native: own, mako } = harness.features[key]
    assert.ok(capabilityText(mako).trim(), `${harness.provider} says where ${HARNESS_FEATURES[key].name} stands`)
    if (mako.state === "implemented" && mako.through === "harness") assert.ok(own?.name.trim(), `${harness.provider} names its own ${HARNESS_FEATURES[key].name}`)
  }
  for (const { name, mako } of harness.unique)
    assert.ok(capabilityText(mako).trim(), `${harness.provider}'s ${name} says where it shows`)
  assert.equal(harness.artifacts.state === "implemented", !harness.absent.artifactPreview, `${harness.provider}'s artifact previews are its artifactPreview family`)
}

// Each harness's versions are declared once, on its updates source, and
// every per-version record Mako keeps is held to its tested version: the
// vocabulary's tools and concepts, the native-tools recording, the current
// decode pairs (each replays its capture through the decoder beside the
// store the same session wrote, and the bump records them again; a pair kept
// from another build is `<scenario>@<version>`, and a standalone decoder
// fixture names the build it was captured from, since the decoders read
// every build's sessions) and the concepts fixture, and for a bundled
// runtime the
// package in Mako's lockfile. A record that names another version fails
// here, unless it's listed below with why.
const RECORD_EXCEPTIONS = new Map<string, Map<"concepts" | "concepts fixture", string>>([
  ["claude", new Map([
    ["concepts", "Claude Code's concepts were checked on October 6 against the terminal CLI 2.1.290 through harness:self-report, not the SDK's 2.1.283 build sessions run; the next `npm run harness:self-report -- claude` against the SDK's build moves them."],
    ["concepts fixture", "Recorded with the concepts, from the terminal CLI 2.1.290."],
  ])],
])
const VersionField = z.object({ version: z.string().optional() })
const ShippedPackage = z.object({ version: z.string(), claudeCodeVersion: z.string().optional() })
const Lockfile = z.object({ packages: z.record(z.string(), z.object({ version: z.string().optional() })) })
const plain = (version: string) => version.replace(/^SDK /, "")
const lockfile = Lockfile.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "package-lock.json"), "utf8")))
for (const { provider } of harnesses) {
  const source = providerHost.updateSources.get(provider)
  const versions = source?.versions
  assert.ok(versions, `${provider} declares the versions Mako runs on its updates source`)
  const { tested, oldest } = versions
  assert.ok(versions.checked.on.trim() && versions.checked.how.trim(), `${provider} says when and how its versions were checked`)
  if (oldest !== undefined) assert.ok(compareVersions(oldest, tested) <= 0, `${provider}'s oldest is not newer than its tested version`)
  for (const [feature, floor] of Object.entries(versions.features ?? {})) {
    assert.ok(floor.evidence.trim(), `${provider}'s floor for ${feature} names its evidence`)
    assert.ok(compareVersions(floor.version, tested) <= 0, `${provider}'s floor for ${feature} is a version Mako tested`)
    if (oldest !== undefined) assert.ok(compareVersions(floor.version, oldest) > 0, `${provider}'s floor for ${feature} is above its oldest, or it would never apply`)
  }
  const exceptions = RECORD_EXCEPTIONS.get(provider)
  const record = (name: "tools" | "concepts" | "native tools" | "decode pairs" | "concepts fixture", found: string | undefined) => {
    const excused = name === "concepts" || name === "concepts fixture" ? exceptions?.get(name) : undefined
    if (excused) {
      assert.notEqual(found, tested, `${provider}'s ${name} now name tested ${tested}; drop its exception`)
      return
    }
    assert.equal(found, tested, `${provider}'s ${name} name ${found ?? "no version"}, but its declared tested version is ${tested}. Rerecord them against ${tested}, or move tested.`)
  }
  const vocabulary = VOCABULARIES.find((entry) => entry.harness === provider)
  assert.ok(vocabulary, `${provider} has a vocabulary`)
  record("tools", plain(vocabulary.checked.version))
  record("concepts", vocabulary.concepts && plain(vocabulary.concepts.checked.version))
  const recordings = readdirSync(join(import.meta.dirname, "fixtures", "native-tools"))
    .map((name) => name.match(new RegExp(`^${provider}-(.+)\\.json$`))?.[1])
    .filter((version) => version !== undefined)
    .sort(compareVersions)
  record("native tools", recordings.at(-1))
  const pairs = await currentPairVersions(provider)
  record("decode pairs", pairs.length ? pairs.join(" and ") : undefined)
  const concepts = join(import.meta.dirname, "fixtures", "native-vocabulary", `${provider}-concepts.json`)
  record("concepts fixture", existsSync(concepts) ? VersionField.parse(JSON.parse(readFileSync(concepts, "utf8"))).version : undefined)
  if (versions.bundled) {
    const locked = lockfile.packages[`node_modules/${versions.bundled.package}`]
    assert.equal(locked?.version, versions.bundled.version, `${provider}'s bundled ${versions.bundled.package} is the one in Mako's lockfile`)
    // The Agent SDK names the Claude Code build it ships; Cursor's SDK is the runtime itself.
    const shipped = ShippedPackage.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "node_modules", versions.bundled.package, "package.json"), "utf8")))
    assert.equal(shipped.version, versions.bundled.version, `${provider}'s installed ${versions.bundled.package} is the lockfile's; run npm install`)
    assert.equal(shipped.claudeCodeVersion ?? shipped.version, tested, `${provider}'s tested version is the build ${versions.bundled.package} ${versions.bundled.version} ships`)
  }
}

// The new-harness checklist is generated from the code, and every installed harness passes its checked steps.
assert.equal(readFileSync(CHECKLIST_PATH, "utf8"), renderHarnessChecklist(), "docs/adding-a-harness.md is behind the code; run npm run harness:checklist")
for (const { provider } of harnesses) assert.deepEqual(missingSteps(provider), [], `${provider} misses steps of docs/adding-a-harness.md`)

console.log(`${"".padEnd(10)}${familyNames.join(" ")}`)
for (const line of matrix) console.log(line)
console.log("PASS: every harness names each capability family, has a live driver and a saved-history reader, and passes the generated checklist")
