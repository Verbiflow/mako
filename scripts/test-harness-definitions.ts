import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { readableHarnesses } from "@mako/sessions"
import { createProviderHost, type ProviderHost } from "../electron/providers/host.ts"
import {
  installHarness,
  lacks,
  type HarnessDefinition,
  type HarnessFamily,
} from "../electron/providers/harness-definition.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { ProviderRegistry, ProviderCapability } from "../electron/providers/registry.ts"

/**
 * A harness is one definition that names every capability family. These
 * checks hold every installed harness to that, so a family a harness skipped
 * fails here rather than going missing in some screen.
 */

const families = {
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
  artifactPreview: "artifactPreviews",
} as const satisfies Record<HarnessFamily, Exclude<keyof ProviderHost, "harnesses">>

// SAFETY: `families` satisfies a record over exactly the HarnessFamily keys.
const familyNames = Object.keys(families) as HarnessFamily[]

const registry = (family: HarnessFamily): ProviderRegistry<ProviderCapability> => providerHost[families[family]]

const harnesses = providerHost.harnesses.list()
assert.deepEqual(
  harnesses.map((harness) => harness.provider),
  ["claude", "codex", "cursor", "grok", "devin", "opencode"]
)

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
  artifactPreview: lacks("test"),
}
assert.throws(() => installHarness(host, definition), /example's live capability is filed under codex/)

console.log(`${"".padEnd(10)}${familyNames.join(" ")}`)
for (const line of matrix) console.log(line)
console.log("PASS: every harness names each capability family, and has a live driver and a saved-history reader")
