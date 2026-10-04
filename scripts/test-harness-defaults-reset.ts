import assert from "node:assert/strict"

const storage = new Map<string, string>()
globalThis.localStorage = {
  get length() {
    return storage.size
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => [...storage.keys()][index] ?? null,
  removeItem: (key) => void storage.delete(key),
  setItem: (key, value) => void storage.set(key, value),
}

// Before this release every model picked for a new conversation became its
// harness's default, as these did; one load drops them and keeps the rest.
const thread = JSON.stringify(["claude", "thread", "/pods", "/pods/one"])
storage.set(
  "mako.prefs.v1",
  JSON.stringify({
    providerSettings: {
      claude: { source: "saved", settings: { model: "claude-fable-5-1" } },
      grok: { source: "legacy", settings: { model: "grok-4.6", options: { effort: "high" } } },
    },
    settingsOverrides: {
      [JSON.stringify(["claude", "new", "/pods"])]: { model: "claude-fable-5-1" },
      [thread]: { model: "claude-sonnet-5" },
    },
    modelLoadout: [{ harness: "claude", model: "claude-fable-5-1" }],
  })
)
const { prefsStore, setPref } = await import("../src/state/prefs.ts")
assert.deepEqual(prefsStore.get().providerSettings, {}, "picks that became defaults are dropped")
assert.deepEqual(prefsStore.get().settingsOverrides, { [thread]: { model: "claude-sonnet-5" } }, "a workspace's pending pick for its next conversation goes; a conversation's own stays")
assert.deepEqual(prefsStore.get().modelLoadout, [{ harness: "claude", model: "claude-fable-5-1" }], "the loadout is untouched")

setPref("providerSettings", { codex: { source: "saved", settings: { model: "gpt-6.1-sol" } } })
await Promise.resolve()
const written = JSON.parse(storage.get("mako.prefs.v1") ?? "{}")
assert.equal(written.harnessDefaultsReset, true, "the reset happens once")
assert.deepEqual(written.providerSettings, { codex: { source: "saved", settings: { model: "gpt-6.1-sol" } } }, "a default saved after it is kept")

console.log("harness defaults reset: composer picks that became defaults are dropped once; defaults saved after are kept")
