import assert from "node:assert/strict"
import { resolveCommitModel } from "../src/state/commit-model.ts"
import type { UtilityModelSettings } from "../electron/contracts/utility-models.ts"
import type { UtilityModelOption, UtilityTaskState } from "../electron/contracts/utility-work.ts"

// The host decides which API key drafts commits (`UtilityWork`); the commit
// box reads that answer: a model it can run, a chosen key that went away (so
// Generate becomes Reconnect key), or nothing yet (Connect API key).
const flash: UtilityModelOption = { id: "google/gemini-flash", label: "gemini-flash", via: "Google", source: "google" }
const base: UtilityModelSettings = { providers: [], connections: [], issues: [], secureStorage: true }
const withCommit = (commit: UtilityTaskState): UtilityModelSettings => ({ ...base, work: { commit } })

assert.deepEqual(resolveCommitModel(null), { model: undefined, label: undefined, status: { kind: "unknown" } }, "before the host answers nothing is claimed")
assert.deepEqual(resolveCommitModel(base), { model: undefined, label: undefined, status: { kind: "unknown" } }, "an older host without choices claims nothing")
assert.deepEqual(
  resolveCommitModel(withCommit({ choice: "auto", resolved: flash, options: [flash] })),
  { model: "google/gemini-flash", label: "gemini-flash · Google", status: { kind: "connected" } },
  "Automatic shows what it resolved to"
)
assert.deepEqual(
  resolveCommitModel(withCommit({ choice: "auto", reason: "Connect an API key in Settings › Git to generate commit messages.", options: [] })),
  { model: undefined, label: undefined, status: { kind: "unknown" } },
  "no key at all is the Connect API key state, not a disconnection"
)
assert.deepEqual(
  resolveCommitModel(withCommit({ choice: "openai/gpt-mini", reason: "openai/gpt-mini is no longer connected.", options: [flash] })),
  { model: "openai/gpt-mini", label: undefined, status: { kind: "disconnected", reason: "openai/gpt-mini is no longer connected." } },
  "a chosen key that went away is reported, never replaced"
)

console.log("Commit model status: loading, older host, Automatic resolved, no key and a lost choice passed")
