import assert from "node:assert/strict"

// The renderer state layer is React-free, but modules read `window` at load.
Object.assign(globalThis, {
  window: {
    mako: {},
    addEventListener() {},
    removeEventListener() {},
    setInterval() {},
    clearInterval() {},
    location: { search: "" },
  },
})

const { chooseProviderMode, providerAccessModes, savedProviderMode } =
  await import("../src/state/provider-access.ts")
const { prefsStore } = await import("../src/state/prefs.ts")
type LiveSessionMode = import("../src/lib/types.ts").LiveSessionMode

const modes: LiveSessionMode[] = [
  { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
  { id: "agent", name: "Agent", access: "ask", enforcement: "provider" },
  { id: "access:full", name: "Full access", access: "full", enforcement: "host" },
]
const state = {
  liveCapabilities: [
    { provider: "cursor", canResume: false, modes },
    { provider: "grok", canResume: true },
  ],
}

// The store's own array comes back, so a selector on it holds still between tokens.
assert.equal(providerAccessModes(state, "cursor"), modes)
assert.equal(providerAccessModes(state, "grok").length, 0, "a driver without a declared ladder offers nothing")
assert.equal(
  providerAccessModes(state, "grok"),
  providerAccessModes(state, "missing"),
  "the empty ladder is one shared value"
)

// A saved choice counts only while the provider still offers it.
assert.equal(savedProviderMode({ cursor: "access:full" }, modes, "cursor"), "access:full")
assert.equal(savedProviderMode({ cursor: "yolo" }, modes, "cursor"), null)
assert.equal(savedProviderMode({}, modes, "cursor"), null)

// Choosing saves per provider and leaves the others alone.
chooseProviderMode("cursor", "plan")
chooseProviderMode("codex", "access:edits")
assert.deepEqual(prefsStore.get().providerModes, { cursor: "plan", codex: "access:edits" })
chooseProviderMode("cursor", "access:full")
assert.deepEqual(prefsStore.get().providerModes, { cursor: "access:full", codex: "access:edits" })
assert.equal(savedProviderMode(prefsStore.get().providerModes, modes, "cursor"), "access:full")

console.log("provider access: ok")
