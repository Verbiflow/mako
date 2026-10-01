import assert from "node:assert/strict"
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

const registry = (family: HarnessFamily): ProviderRegistry<ProviderCapability> => providerHost[families[family]]

const harnesses = providerHost.harnesses.list()
assert.deepEqual(
  harnesses.map((harness) => harness.provider),
  ["claude", "codex", "cursor", "grok", "devin", "opencode"]
)

for (const family of Object.keys(families) as HarnessFamily[]) {
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
  for (const family of Object.keys(families) as HarnessFamily[]) {
    const present = registry(family).get(provider) !== undefined
    const reason = absent[family]
    assert.notEqual(present, reason !== undefined, `${provider} must give its ${family} or say why it has none`)
    if (reason) assert.ok(reason.reason.length > 0, `${provider} says why it has no ${family}`)
    row.push(present ? "yes" : reason?.absent === "mako" ? "gap" : "-")
  }
  matrix.push(`${provider.padEnd(9)} ${row.map((cell, index) => cell.padEnd(Object.keys(families)[index]!.length + 1)).join("")}`)
  assert.ok(readableHarnesses().includes(provider), `${provider} has a saved-history reader in @mako/sessions`)
  assert.ok(registry("live").get(provider), `${provider} has a live driver`)
}

const host = createProviderHost()
const stub = { provider: "other" } as unknown as HarnessDefinition["profile"]
const definition = {
  ...Object.fromEntries((Object.keys(families) as HarnessFamily[]).map((family) => [family, lacks("test")])),
  provider: "example",
  live: providerHost.liveDrivers.get("codex")!,
  profile: stub,
} as HarnessDefinition
assert.throws(() => installHarness(host, definition), /example's live capability is filed under codex/)

console.log(`${"".padEnd(10)}${Object.keys(families).join(" ")}`)
for (const line of matrix) console.log(line)
console.log("PASS: every harness names each capability family, and has a live driver and a saved-history reader")
