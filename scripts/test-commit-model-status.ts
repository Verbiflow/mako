import assert from "node:assert/strict"
import { resolveCommitModel } from "../src/state/commit-model.ts"
import type { UtilityModelSettings } from "../electron/contracts/utility-models.ts"
import type { UtilityModelOption, UtilityTaskState } from "../electron/contracts/utility-work.ts"

// The host decides which model drafts commits (`UtilityWork`); the commit box
// reads that answer: a model it can run, a chosen model that went away (so
// Generate becomes Choose model), or nothing yet (Connect model).
const haiku: UtilityModelOption = { id: "agent:claude/haiku", label: "Haiku", via: "Claude Code", kind: "agent", source: "claude", light: true }
const base: UtilityModelSettings = { providers: [], connections: [], issues: [], secureStorage: true }
const withCommit = (commit: UtilityTaskState): UtilityModelSettings => ({
  ...base,
  work: { title: { choice: "auto", options: [] }, commit },
})

assert.deepEqual(resolveCommitModel(null), { model: undefined, label: undefined, status: { kind: "unknown" } }, "before the host answers nothing is claimed")
assert.deepEqual(resolveCommitModel(base), { model: undefined, label: undefined, status: { kind: "unknown" } }, "an older host without choices claims nothing")
assert.deepEqual(
  resolveCommitModel(withCommit({ choice: "auto", resolved: haiku, options: [haiku] })),
  { model: "agent:claude/haiku", label: "Haiku · Claude Code", status: { kind: "connected" } },
  "Automatic shows what it resolved to"
)
assert.deepEqual(
  resolveCommitModel(withCommit({ choice: "auto", reason: "Nothing can write commit messages", options: [] })),
  { model: undefined, label: undefined, status: { kind: "unknown" } },
  "nothing to run Automatic is the Connect model state, not a disconnection"
)
assert.deepEqual(
  resolveCommitModel(withCommit({ choice: "google/gemini-pro", reason: "google/gemini-pro is no longer connected.", options: [haiku] })),
  { model: "google/gemini-pro", label: undefined, status: { kind: "disconnected", reason: "google/gemini-pro is no longer connected." } },
  "a chosen model that went away is reported, never replaced"
)

console.log("Commit model status: loading, older host, Automatic resolved, nothing available and a lost choice passed")
