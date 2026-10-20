/**
 * A hibernated conversation's Local Control session waits for the provider
 * that wakes in its place: the tab it opened, its lease and its program state
 * survive, the old provider's grant does not, and the 30-minute limit (short
 * here) ends the session. Real pieces throughout: the conversation owner's
 * hibernate and wake, the host's residency, the conversation MCP server and
 * its grants, Local Control sessions and workers, the browser service and a
 * headless Chromium. Only the provider is scripted: each turn it connects to
 * the MCP grant the host handed it, as a harness does, and runs `js` cells.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { BrowserService } from "@mako/control-runtime/browser"
import { ControlWorkers, startDesktopControlSession } from "@mako/control-runtime/session"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { ControlResidency } from "@mako/host/control/residency"
import { startControlService } from "@mako/host/control/service"
import { ControlSessions } from "@mako/host/control/sessions"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ConversationTools, ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const executable =
  process.env.CHROMIUM_EXECUTABLE ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium")
if (!existsSync(executable)) {
  console.log(`Local Control hibernation skipped: no Chromium at ${executable}; set CHROMIUM_EXECUTABLE`)
  process.exit(0)
}

async function until(check: () => boolean, what: string, ms = 15_000) {
  const deadline = performance.now() + ms
  while (!check()) {
    assert.ok(performance.now() < deadline, what)
    await delay(10)
  }
}

const root = await mkdtemp(join(tmpdir(), "mako-control-hibernation-"))
const chromium = spawn(
  executable,
  ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(root, "profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] }
)
const endpoint = await new Promise<string>((done, fail) => {
  let stderr = ""
  const timer = setTimeout(() => fail(new Error("Chromium startup timed out")), 15_000)
  chromium.once("exit", () => fail(new Error("Chromium exited before its endpoint")))
  chromium.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_384)
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
    if (match) {
      clearTimeout(timer)
      done(match[1]!)
    }
  })
})
const page = `data:text/html,${encodeURIComponent("<title>Kept</title><button onclick=\"this.textContent='Pressed '+(++window.presses)\">Press</button><script>window.presses=0</script>")}`

// The scripted provider. A turn runs `agent` with the grant its process was started with.
const id = randomUUID()
const nativePath = join(root, "native-session.jsonl")
await writeFile(nativePath, "fixture native session")
const session: LiveSessionState = { id, nativeId: "native-hibernation", nativePath, harness: "hibernation-fixture", cwd: root, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
const grants: ConversationTools[] = []
let emit: ((event: LiveDriverEvent) => void) | undefined
let agent: ((tools: ConversationTools) => Promise<void>) | undefined
let agentFailure: Error | undefined
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  approvalEvidence: { kind: "submission-only", reason: "Scripted provider" },
  launchEnvironment: { kind: "unavailable", reason: "Scripted provider" },
  nativeIdentity: { kind: "unavailable", reason: "Scripted provider" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Scripted provider", feedback: { kind: "next-message", reason: "Scripted provider" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Scripted provider" },
  turnRecovery: { kind: "manual", reason: "Scripted provider" },
  provider: "hibernation-fixture",
  available: () => true,
  start: async (_cwd, options) => {
    assert.ok(options.conversationTools, "every provider start gets a grant")
    grants.push(options.conversationTools)
    emit = options.emit
    return session
  },
  prompt: async (promptId, _text, _attachments, _settings, dispatch) => {
    emit!({ type: "live-session", session: { ...session, status: "running" } })
    dispatch.report({ kind: "accepted", source: "native-response" })
    const tools = grants.at(-1)!
    void (agent ? agent(tools) : Promise.resolve()).catch((error: Error) => { agentFailure = error }).finally(() => {
      emit!({ type: "live-update", id: promptId, update: { kind: "text", text: "done" } })
      emit!({ type: "live-session", session })
    })
  },
  permission: async () => {}, cancel: async () => {}, setMode: async () => {},
  close: async () => {},
}

const browser = new BrowserService([{ id: "live", name: "Live Chromium", endpoint: async () => endpoint, transport: "direct", kind: "chromium" }])
const workers = new ControlWorkers()
const sessions = new ControlSessions(async () => undefined, startDesktopControlSession, workers)
let mcp: Awaited<ReturnType<typeof startConversationMcp>> | undefined
let control: Awaited<ReturnType<typeof startControlService>> | undefined
const SLEEP_MS = 2500
const residency = new ControlResidency({
  sessions,
  grants: () => mcp,
  browser: () => control,
  journal: (conversationId) => join(root, "logs", `${conversationId}.jsonl`),
  notice: (message) => { throw new Error(`Unexpected notice: ${message}`) },
  sleepMs: SLEEP_MS,
})
const owner = new LiveConversations({
  root: join(root, "journals"), appPath: root, driver: () => driver,
  history: async () => null, emit() {}, providerIdleMs: 600_000, providerWarmLimit: 20,
  checkpoint: async () => "fixture-checkpoint", resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  tools: (bindingId, conversationId) => residency.tools(bindingId, conversationId),
  revokeTools: (bindingId, conversationId) => residency.revoke(bindingId, conversationId),
  suspendTools: (bindingId, conversationId) => residency.suspend(bindingId, conversationId),
})
mcp = await startConversationMcp(owner, (bindingId, operation, signal) => sessions.request(bindingId, operation, signal))
control = await startControlService(browser, (conversationId, bindingId) => owner.authorizeAgent(conversationId, bindingId))

const ToolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
})
async function connect(tools: ConversationTools) {
  const client = new Client({ name: "hibernation-provider", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(tools.computerUrl), {
    requestInit: { headers: { authorization: `Bearer ${tools.token}` } },
  }))
  const documented: boolean[] = []
  return {
    client,
    /** Whether each cell came with the documentation a session prints once, first. */
    documented,
    async js(code: string) {
      const result = ToolResultSchema.parse(await client.callTool({ name: "js", arguments: { code, timeout_ms: 30_000 } }))
      const text = result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
      if (result.isError) throw new Error(text)
      const [preface, output] = text.split("This cell's output:\n")
      documented.push(output !== undefined)
      return output ?? preface!
    },
  }
}
async function turn(text: string, work: (tools: ConversationTools) => Promise<void>) {
  agent = work
  agentFailure = undefined
  const requestId = randomUUID()
  owner.submit(id, requestId, text)
  await until(() => owner.snapshot(id)?.requests.some((request) => request.id === requestId && request.status === "completed") ?? false, `"${text}" completed`, 60_000)
  agent = undefined
  if (agentFailure) throw agentFailure
}
const hibernate = async () => {
  assert.equal(owner.hibernateIfIdle(id), true, "an idle conversation hibernates")
  await until(() => owner.snapshot(id)?.session.connection === "hibernated", "the provider hibernated")
}

try {
  await owner.start(driver.provider, root, { conversationId: id, title: "Kept tab" })
  await until(() => owner.snapshot(id)?.session.status === "ready", "the conversation opened")
  const binding = owner.snapshot(id)!.control!.activeBindingId

  // Turn 1: open a tab, press its button, keep the handle in program state.
  let target = ""
  let staleClient: Awaited<ReturnType<typeof connect>> | undefined
  await turn("open the page", async (tools) => {
    staleClient = await connect(tools)
    await staleClient.js(`await control.connectBrowser("live"); state.tab = await control.openTab({browser:"live", url:${JSON.stringify(page)}}); state.note = "kept"; return true`)
    assert.match(await staleClient.js(`await state.tab.locator({role:"button",name:"Press"}).click(); await state.tab.evaluate("window.presses")`), /\b1\b/)
    target = await staleClient.js("JSON.stringify(state.tab.target)")
    assert.deepEqual(staleClient.documented, [true, false, false], "a new session documents itself once")
  })
  const firstLaunch = grants[0]!.control
  assert.ok(firstLaunch, "the first provider got the Local Control CLI")

  // Hibernate: the provider's grant ends, its session and tab wait.
  await hibernate()
  assert.equal(residency.asleep(binding), true, "the session waits for the wake")
  assert.ok(sessions.get(binding), "the session is kept")
  await assert.rejects(staleClient!.js("1"), "the hibernated provider's grant is revoked")
  await staleClient!.client.close().catch(() => {})

  // Turn 2: the woken provider gets a new grant to the same session.
  const wokeAt = performance.now()
  await turn("press it again", async (tools) => {
    const woken = await connect(tools)
    try {
      assert.equal(await woken.js("state.note"), "kept", "program state survives hibernation")
      assert.equal(await woken.js("JSON.stringify(state.tab.target)"), target, "the tab handle keeps its exact target and lease")
      assert.match(await woken.js(`await state.tab.observe()`), /Pressed 1/, "the kept tab still shows the first turn's press")
      assert.match(await woken.js(`await state.tab.locator({role:"button",name:"Pressed 1"}).click(); await state.tab.evaluate("window.presses")`), /\b2\b/)
      assert.ok(!woken.documented.includes(true), "the woken provider's session is the same one: no documentation again")
    } finally {
      await woken.client.close()
    }
  })
  const wakeMs = Math.round(performance.now() - wokeAt)
  assert.equal(grants.length, 2)
  assert.notEqual(grants[1]!.token, grants[0]!.token, "the woken provider gets its own grant")
  assert.equal(grants[1]!.control?.sessionFile, firstLaunch.sessionFile, "the CLI reaches the same session")
  assert.equal(residency.asleep(binding), false)

  // Past the limit the session ends; the next wake starts a fresh one.
  await hibernate()
  await until(() => !sessions.get(binding), "the session ends after the sleep limit", SLEEP_MS + 10_000)
  await turn("start over", async (tools) => {
    const fresh = await connect(tools)
    try {
      assert.equal(await fresh.js("String(state.note)"), "undefined", "an expired session's program state is gone")
      const old = await fresh.js(`try { await control.tab(${target}).observe(); return "still bound" } catch (error) { return String(error.message) }`)
      assert.notEqual(old, "still bound", "an expired session's lease is released")
      assert.equal(fresh.documented[0], true, "a replaced session documents itself")
    } finally {
      await fresh.client.close()
    }
  })
  assert.notEqual(grants[2]!.control?.sessionFile, firstLaunch.sessionFile, "an expired session is replaced, not resumed")

  // Closing a hibernated conversation ends what its binding holds.
  await hibernate()
  await owner.close(id)
  assert.equal(sessions.get(binding), undefined)
  assert.equal(residency.asleep(binding), false)
  console.log(`Local Control hibernation: a kept tab, its lease and program state survive hibernate and wake (wake turn ${wakeMs} ms), the old grant is refused, and the sleep limit and close end the session`)
} finally {
  owner.stop()
  await sessions.close().catch(() => {})
  await workers.close().catch(() => {})
  control?.close()
  mcp?.close()
  browser.close()
  chromium.kill()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
