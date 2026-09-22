// Protocol-fixture checks, not a live Linux desktop test. Run after build:electron.
import assert from "node:assert/strict"
import { pathToFileURL, fileURLToPath } from "node:url"
import { resolve, dirname } from "node:path"
import { writeFile } from "node:fs/promises"
const root =
  process.env.MAKO_AUDIT_BUILD_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const load = (path) => import(pathToFileURL(resolve(root, path)).href)
const { controlClient } = await load("packages/control/dist/control/client.js")
const { windowCapabilities } = await load(
  "packages/control/dist/computer/control-contract.js"
)
const { verifyForegroundInput } = await load(
  "dist-electron/computer-input-target.js"
)
const target = { kind: "window", pid: 42, window_id: 7 }
let dispatches = 0
// Linux get_window_state unconditionally sets elements_complete:false;
// Mako preserves that in coverage.complete and treats absent value_exact as false.
const observation = {
  target,
  observation: "s00000001",
  nodes: [
    { role: "push button", name: "Save", ref: "s00000001:1", depth: 0 },
    {
      role: "entry",
      name: "Name",
      value: "  東京 🐟  ",
      valueExact: false,
      ref: "s00000001:2",
      depth: 0,
    },
  ],
  lines: [],
  coverage: { complete: false, omitted: 0, textComplete: true },
}
const api = controlClient(async (action) => {
  if (action === "observe") return observation
  dispatches++
  throw Error("Unexpected dispatch")
})
const window = api.window({ pid: 42, window_id: 7 })
const evidence = {
  kind: "source-derived protocol fixture; no native input",
  checks: [],
}
async function refusal(name, run, pattern) {
  let message
  try {
    await run()
  } catch (e) {
    message = e.message
  }
  assert.match(message ?? "", pattern)
  evidence.checks.push({ name, result: "reproduced", message })
}
await refusal(
  "Linux strict locator refuses incomplete observation",
  () => window.locator({ role: "push button", name: "Save" }).click(),
  /coverage is incomplete/
)
await refusal(
  "Linux exact value assertion lacks driver guarantee",
  () =>
    window.expect(
      { role: "entry", name: "Name", value: "  東京 🐟  " },
      { timeoutMs: 0 }
    ),
  /Exact value unavailable/
)
await refusal(
  "Linux active:false makes current foreground guard refuse",
  () =>
    verifyForegroundInput(
      {
        callTool: async (name) => {
          assert.equal(name, "list_apps")
          return { structuredContent: { apps: [{ pid: 42, active: false }] } }
        },
      },
      target,
      new AbortController().signal
    ),
  /not frontmost/
)
assert.equal(dispatches, 0)
const capabilities = windowCapabilities({
  target: { pid: 42, window_id: 7 },
  documentWindows: 0,
  onScreen: true,
})
const pointer = capabilities.routes.find((r) => r.route === "window-pointer")
assert.equal(pointer.status, "available")
assert.equal(pointer.background, true)
evidence.checks.push({
  name: "Capabilities claim background pointer availability without platform/backend evidence",
  result: "reproduced",
  capability: pointer,
})
evidence.dispatches = dispatches
await writeFile(
  new URL("./probe-results.json", import.meta.url),
  JSON.stringify(evidence, null, 2) + "\n"
)
console.log(JSON.stringify(evidence, null, 2))
