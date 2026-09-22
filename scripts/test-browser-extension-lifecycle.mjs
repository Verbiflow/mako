import assert from "node:assert/strict"
import { runInNewContext } from "node:vm"
import { webcrypto } from "node:crypto"
import { build } from "esbuild"
const built = await build({
  entryPoints: ["browser-extension/background.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
})
function event() {
  const listeners = []
  return {
    addListener: (f) => listeners.push(f),
    emit: (...args) => listeners.forEach((f) => f(...args)),
  }
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error("Lifecycle fixture timed out")
}
async function fixture(protocol) {
  const messages = []
  const targets = []
  let reloads = 0
  let journal = {}
  const port = {
    onMessage: event(),
    onDisconnect: event(),
    postMessage: (m) => messages.push(m),
    disconnect: () => port.onDisconnect.emit(),
  }
  const api = {
    runtime: {
      id: "fixture",
      getManifest: () => ({ version: "0.3.0" }),
      getURL: (path) => `chrome-extension://fixture/${path}`,
      connectNative: () => port,
      reload: () => {
        reloads++
      },
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      onUpdateAvailable: event(),
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: async () => journal,
        set: async (v) => {
          journal = v
        },
        remove: async () => {
          journal = {}
        },
      },
    },
    alarms: { create: () => {}, clear: async () => {}, onAlarm: event() },
    windows: {
      get: async () => ({ focused: true }),
      getAll: async () => [{ id: 1, state: "normal" }],
      onFocusChanged: event(),
      onBoundsChanged: event(),
    },
    tabs: {
      query: async () => [],
      get: async () => ({ id: 1, windowId: 1, groupId: 1, active: false }),
      update: async () => ({}),
      group: async () => 1,
      create: async () => {
        targets.push({
          id: "tab",
          tabId: 1,
          type: "page",
          title: "Fixture",
          url: "about:blank",
        })
        return { id: 1 }
      },
      remove: async () => {
        targets.length = 0
      },
      onCreated: event(),
      onActivated: event(),
      onRemoved: event(),
    },
    tabGroups: {
      get: async () => ({ id: 1, windowId: 1, title: "Mako" }),
      update: async () => {},
    },
    downloads: {
      onChanged: { addListener: () => {}, removeListener: () => {} },
      download: async () => 1,
      search: async () => [],
    },
    debugger: {
      getTargets: async () => targets,
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
      onEvent: event(),
      onDetach: event(),
    },
  }
  runInNewContext(built.outputFiles[0].text, {
    fetch: async () => ({ ok: true, json: async () => ({ version: "0.3.0" }) }),
    chrome: api,
    crypto: webcrypto,
    navigator: { userAgent: "Chrome/153" },
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    console,
    URL,
  })
  await until(() => messages.some((m) => m.kind === "hello"))
  assert.equal(messages[0].protocol, 1)
  port.onMessage.emit({ kind: "ready", protocol })
  return { api, port, messages, reloads: () => reloads }
}
const mismatch = await fixture(2)
mismatch.port.onMessage.emit({
  kind: "request",
  client: "task",
  command: {
    id: 1,
    method: "Target.createTarget",
    params: { url: "about:blank" },
  },
})
await new Promise((r) => setTimeout(r, 10))
assert.equal(
  mismatch.messages.filter((m) => m.kind === "response").length,
  0,
  "Mismatched host cannot dispatch"
)
const matching = await fixture(1)
async function request(id, method, params = {}) {
  matching.port.onMessage.emit({
    kind: "request",
    client: "task",
    command: { id, method, params },
  })
  await until(() => matching.messages.some((m) => m.id === id))
  const response = matching.messages.find((m) => m.id === id)
  assert.equal(response.kind, "response", JSON.stringify(response))
  return response.result
}
await request(1, "Target.createTarget", {
  url: "about:blank",
  makoTaskLifetime: true,
})
const { sessionId } = await request(2, "Target.attachToTarget", {
  targetId: "tab",
})
matching.api.runtime.onUpdateAvailable.emit({ version: "0.4.0" })
assert.equal(matching.reloads(), 0, "Update cannot interrupt an attached tab")
await request(3, "Target.detachFromTarget", { sessionId })
assert.equal(matching.reloads(), 0, "Update cannot strand an unclosed task tab")
await request(4, "Target.closeTarget", { targetId: "tab" })
await until(() => matching.reloads() === 1)
assert.equal(matching.reloads(), 1)
console.log(
  "Extension lifecycle: protocol mismatch refuses requests; updates wait for both actions and task resources to finish"
)

const updater = await build({
  entryPoints: ["browser-extension/updates.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
})
const { localExtensionUpdateAvailable } = await import(
  `data:text/javascript;base64,${Buffer.from(updater.outputFiles[0].text).toString("base64")}`
)
for (const [current, available, expected] of [
  ["0.3.0", "0.3.0", false],
  ["0.3.9", "0.3.10", true],
  ["0.4.0", "0.3.99", false],
  ["1.0", "1.0.0.0", false],
]) {
  assert.equal(
    await localExtensionUpdateAvailable(
      {
        getURL: (p) => `chrome-extension://fixture/${p}`,
        getManifest: () => ({ version: current }),
      },
      async (url, options) => {
        assert.equal(url, "chrome-extension://fixture/manifest.json")
        assert.equal(options.cache, "no-store")
        return { ok: true, json: async () => ({ version: available }) }
      }
    ),
    expected
  )
}
console.log(
  "Local extension updates compare numeric versions, bypass cache and never downgrade"
)
