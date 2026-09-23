import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { startControlService } from "../electron/control-service.js"
import { z } from "zod"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserService } from "../packages/control-runtime/src/browser-service.js"
import {
  BrowserCommandSchema,
  BrowserFault,
  BrowserTargetSchema,
} from "../packages/control-runtime/src/contracts/browser-control.js"
import { browserFixture } from "./browser-control-fixture.js"
import { BrowserPreferences } from "../packages/control-runtime/src/browser-preference.js"
import { tabInterruption } from "../packages/control-runtime/src/browser-compatibility.js"

const root = await mkdtemp(join(tmpdir(), "mako-browser-preference-"))
const first = await browserFixture(),
  second = await browserFixture()
const definitions = [
  {
    ...first.definition,
    id: "aside",
    name: "Aside profile abc123",
    product: "Aside",
    kind: "chromium" as const,
    transport: "extension" as const,
  },
  {
    ...second.definition,
    id: "chrome",
    name: "Chrome profile def456",
    product: "Chrome",
    kind: "chromium" as const,
    transport: "extension" as const,
  },
]
const preferencePath = join(root, "browser.json")
const service = new BrowserService(definitions, { preferencePath })
const run = (input: z.input<typeof BrowserCommandSchema>) =>
  service.execute(
    "owner",
    BrowserCommandSchema.parse(input),
    AbortSignal.timeout(3000)
  )
try {
  await assert.rejects(run({ action: "open" }), /preferred browser/)
  await service.prefer("aside")
  assert.equal(
    first.connections(),
    0,
    "Preference does not request browser approval"
  )
  await assert.rejects(run({ action: "open" }), (error: Error) =>
    error instanceof BrowserFault && error.detail.code === "disconnected" && error.detail.outcome === "not-dispatched"
  )
  await service.connect("aside")
  const original = BrowserTargetSchema.parse(await run({ action: "open" }))
  assert.equal(original.browser, "aside")
  await service.prefer("chrome")
  await service.connect("chrome")
  const chosen = BrowserTargetSchema.parse(await run({ action: "open" }))
  assert.equal(chosen.browser, "chrome")
  await run({ action: "observe", target: original })
  const explicit = BrowserTargetSchema.parse(
    await run({ action: "open", browser: "aside" })
  )
  assert.equal(
    explicit.browser,
    "aside",
    "Explicit choice overrides preference"
  )
  await run({ action: "release", target: chosen })
  assert.equal(service.status().find(b => b.id === "chrome")!.lastInterruption, undefined, "Normal release is not a failure")
  const session = first.sessionFor(original.tab)!
  first.emit(session, "Page.frameStartedNavigating", {
    frameId: "child",
    url: "chrome-extension://fjdhphbdlfjogobdofoaagnlnkoibdge/iframe.html#secret",
  })
  first.emit(session, "Target.detachedFromTarget", {
    sessionId: session,
    targetId: original.tab,
    reason: "target_closed",
  })
  await new Promise((r) => setTimeout(r, 30))
  const statuses = service.status()
  assert.match(
    statuses.find((b) => b.id === "aside")!.lastInterruption!.message,
    /Aside extension frame/
  )
  assert.equal(
    statuses.find((b) => b.id === "chrome")!.lastInterruption,
    undefined
  )
  assert.equal(
    JSON.stringify(statuses).includes("secret"),
    false,
    "Diagnostic stores no page URL or query"
  )
  assert.equal(first.connections(), 1, "Diagnostics do not reconnect or probe")
  await assert.rejects(
    run({ action: "observe", target: original }),
    /stale|claim|select|closed/i
  )
  const saved = JSON.parse(await readFile(preferencePath, "utf8"))
  assert.equal(saved.id, "chrome")
  const restarted = new BrowserService([definitions[0]!], { preferencePath })
  try {
    await restarted.refresh()
    const absent = restarted.status().find((b) => b.preferred)
    assert.equal(absent?.id, "chrome")
    assert.equal(absent?.connection.status, "unavailable")
    await assert.rejects(
      restarted.execute(
        "new",
        BrowserCommandSchema.parse({ action: "open" }),
        AbortSignal.timeout(1000)
      ),
      /browser|available|Unknown/i
    )
    assert.equal(
      first.connections(),
      1,
      "Unavailable preference never falls back"
    )
    await restarted.prefer(null)
    assert.equal(
      restarted.status().some((b) => b.preferred),
      false
    )
  } finally {
    restarted.close()
  }
  const preferences = new BrowserPreferences(join(root, "queued.json"))
  await Promise.all([
    preferences.set({ id: "one", name: "One" }),
    preferences.set({ id: "two", name: "Two" }),
  ])
  assert.equal(preferences.value?.id, "two")
  assert.match(tabInterruption([], "canceled_by_user"), /canceled by the user/)
  assert.equal(tabInterruption([], "target_closed").includes("Aside"), false)
  const host = await startControlService(service, () => {})
  const credentials = host.mint("preferred-api", "preferred-binding")
  const client = new Client({name:"preferred-browser-test",version:"1"})
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(process.cwd(),"packages/control-runtime/dist/computer-tools-main.js")],env:{PATH:process.env.PATH ?? "",MAKO_CONTROL_URL:credentials.url,MAKO_CONTROL_TOKEN:credentials.token},stderr:"pipe"}))
    const result = await client.callTool({name:"mako_control_exec",arguments:{source:"state.page = await control.openTab({}); return state.page.target;"}})
    assert.equal(result.isError, undefined, JSON.stringify(result))
    const content = z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough()).parse(result.content)
    const returned = content.filter(b=>b.type==="text").at(-1)?.text
    assert.equal(z.object({browser:z.string()}).parse(JSON.parse(returned!)).browser,"chrome", "Public MCP resolves the saved profile without a browser argument")
  } finally { await client.close(); await host.close() }
  console.log(
    "PASS: persisted browser choice, explicit overrides, unchanged existing handles, unavailable-profile refusal, serialized saves, scoped event diagnostics, no probes or reconnects"
  )
} finally {
  await service.releaseOwner("owner")
  service.close()
  await Promise.all([first.close(), second.close()])
  await rm(root, { recursive: true, force: true })
}
