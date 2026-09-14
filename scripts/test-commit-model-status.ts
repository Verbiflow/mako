import assert from "node:assert/strict"
import { commitModelStatus, resolveCommitModel } from "../src/state/commit-model.ts"
import type { UtilityModelSettings } from "../electron/contracts/utility-models.ts"

// The commit box reads whether the remembered drafting model is still a
// connection the host can open, and turns Generate into Reconnect model when
// it is not, instead of failing a draft and printing the exception.
const settings: UtilityModelSettings = {
  providers: [
    { id: "google", name: "Google", description: "" },
    { id: "openai-compatible", name: "OpenAI-compatible", description: "" },
  ],
  connections: [{ provider: "google", model: "gemini-3.8-flash", contextTokens: 1 }],
  issues: [],
  secureStorage: true,
}

assert.deepEqual(commitModelStatus(null, "google/gemini-3.8-flash"), { kind: "unknown" }, "nothing loaded yet is not a verdict")
assert.deepEqual(commitModelStatus(settings, undefined), { kind: "unknown" }, "no model chosen is the Connect model state, not a disconnection")
assert.deepEqual(commitModelStatus(settings, "google/gemini-3.8-flash"), { kind: "connected" })

const swapped = commitModelStatus(settings, "google/gemini-3.9-pro")
assert.equal(swapped.kind, "disconnected", "a connection replaced by another model no longer covers the saved one")
assert.match(swapped.kind === "disconnected" ? swapped.reason : "", /Google is no longer connected/)

const gone = commitModelStatus({ ...settings, connections: [] }, "openai-compatible/qwen3")
assert.equal(gone.kind, "disconnected")
assert.match(gone.kind === "disconnected" ? gone.reason : "", /OpenAI-compatible is no longer connected/)

const unknownProvider = commitModelStatus(settings, "mystery/model")
assert.equal(unknownProvider.kind, "disconnected")
assert.match(unknownProvider.kind === "disconnected" ? unknownProvider.reason : "", /This model is no longer connected/)

const locked = commitModelStatus(
  { ...settings, issues: [{ provider: "google", message: "The saved model connection could not be opened. Unlock your system keychain." }] },
  "google/gemini-3.8-flash"
)
assert.equal(locked.kind, "disconnected", "a connection the host cannot open counts as disconnected even when its row exists")
assert.match(locked.kind === "disconnected" ? locked.reason : "", /Unlock your system keychain/)

// The preference is this renderer's own storage while connections are per
// user, so a window that never chose a model still drafts with the one that
// is connected — "Connect model" over a live connection was the bug.
assert.deepEqual(
  resolveCommitModel(settings, undefined),
  { model: "google/gemini-3.8-flash", status: { kind: "connected" }, source: "connection" },
  "no preference falls back to the connected model"
)
assert.deepEqual(
  resolveCommitModel(settings, "auto"),
  { model: "google/gemini-3.8-flash", status: { kind: "connected" }, source: "connection" },
  "legacy placeholder values are no choice"
)
assert.deepEqual(
  resolveCommitModel(settings, "google/gemini-3.8-flash"),
  { model: "google/gemini-3.8-flash", status: { kind: "connected" }, source: "preference" }
)
assert.equal(resolveCommitModel(settings, "google/gemini-3.9-pro").status.kind, "disconnected", "an explicit choice is honoured, not silently replaced")
assert.deepEqual(
  resolveCommitModel({ ...settings, connections: [] }, undefined),
  { model: undefined, status: { kind: "unknown" }, source: "none" },
  "nothing connected is the Connect model state"
)
assert.deepEqual(
  resolveCommitModel(null, undefined),
  { model: undefined, status: { kind: "unknown" }, source: "none" },
  "before the connections load nothing is claimed"
)
const twoProviders: UtilityModelSettings = {
  ...settings,
  connections: [
    { provider: "google", model: "gemini-3.8-flash", contextTokens: 1 },
    { provider: "openai-compatible", model: "qwen3", contextTokens: 1 },
  ],
  issues: [{ provider: "google", message: "Unlock your system keychain." }],
}
assert.equal(
  resolveCommitModel(twoProviders, undefined).model,
  "openai-compatible/qwen3",
  "the default skips a connection the host cannot open"
)

console.log("Commit model status: unknown, connected, swapped, removed, unknown provider, locked keychain and the connection default passed")
