import assert from "node:assert/strict"

// The renderer state layer is React-free, but modules read `window` at load.
Object.assign(globalThis, {
  window: {
    // The host keeps the choices; this one never answers, so the window's own showing of them is what's checked.
    mako: { chooseAccess: () => new Promise(() => {}) },
    addEventListener() {},
    removeEventListener() {},
    setInterval() {},
    clearInterval() {},
    location: { search: "" },
  },
})

const { chooseProviderMode, providerAccessModes, providerDefaultMode, savedProviderMode } =
  await import("../src/state/provider-access.ts")
const { accessChoicesStore } = await import("../src/state/access-choices.ts")
const { fixtureDeclarations } = await import("../src/dev/harness-fixtures.ts")
type LiveSessionMode = import("../src/lib/types.ts").LiveSessionMode

const modes: LiveSessionMode[] = [
  { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
  { id: "agent", name: "Agent", access: "ask", enforcement: "provider" },
  { id: "access:full", name: "Full access", access: "full", enforcement: "launch" },
]
const state = {
  descriptors: [
    { provider: "cursor", displayName: "Cursor", resumable: true, live: true, ...fixtureDeclarations("cursor"), modes, defaultMode: "agent" },
    { provider: "grok", displayName: "Grok", resumable: true, live: true, ...fixtureDeclarations("grok") },
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

// The declared default counts only while the provider still offers it, and a
// provider without one has none.
assert.equal(providerDefaultMode(state, modes, "cursor"), "agent")
assert.equal(providerDefaultMode(state, modes, "grok"), null)
assert.equal(providerDefaultMode(state, [], "cursor"), null)

// Choosing saves per provider and leaves the others alone.
chooseProviderMode("cursor", "plan")
chooseProviderMode("codex", "access:edits")
assert.deepEqual(accessChoicesStore.get().modes, { cursor: "plan", codex: "access:edits" })
chooseProviderMode("cursor", "access:full")
assert.deepEqual(accessChoicesStore.get().modes, { cursor: "access:full", codex: "access:edits" })
assert.equal(savedProviderMode(accessChoicesStore.get().modes, modes, "cursor"), "access:full")

console.log("provider access: ok")
