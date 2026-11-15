import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mock } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"
import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { ControlSessions } from "@mako/host/control/sessions"
import { startControlService } from "@mako/host/control/service"
import { BrowserService } from "@mako/control-runtime/browser"
import { onPackageLoad } from "@mako/lazy"
import { browserFixture } from "./browser-control-fixture.js"
import {
  applyControlEnvironment,
  controlLine,
} from "@mako/host/control/launch"
const run = promisify(execFile)
await longLivedTools()
const fixture = await browserFixture()
const browsers = new BrowserService([fixture.definition])
const service = await startControlService(browsers, () => {})
const sessions = new ControlSessions(async () => undefined)
const reasons: string[] = []
const grants = await startConversationMcp({
  authorizeAgent: (conversationId, bindingId) => { assert.equal(conversationId, "conversation"); assert.equal(bindingId, "binding") },
}, (bindingId, operation, signal) => sessions.request(bindingId, operation, signal))
const agent = new Client({ name: "desktop-agent", version: "1" })
try {
  const launch = await sessions.start(
    "binding",
    service.mint("conversation", "binding"),
    async (reason) => {
      reasons.push(reason)
      await service.revoke("conversation", "binding")
    }
  )
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    MAKO_CONTROL_URL: "must-not-leak",
    MAKO_CONTROL_TOKEN: "must-not-leak",
    MAKO_CONTROL_SESSION_FILE: "old",
  }
  applyControlEnvironment(env, launch)
  assert.equal(env.MAKO_CONTROL_TOKEN, undefined)
  assert.equal(env.MAKO_CONTROL_URL, undefined)
  assert.equal(env.MAKO_CONTROL_SESSION_FILE, launch.sessionFile)
  assert.ok(env.PATH?.startsWith(launch.bin))
  assert.ok(controlLine(launch).includes(launch.command))
  assert.deepEqual(await sessions.processes(), { bindings: { binding: undefined }, spare: undefined }, "a launch starts no worker")
  assert.equal(JSON.parse(await readFile(launch.sessionFile, "utf8")).pid, process.pid, "the session file names its owner, which listens until a worker takes over")
  // Warmed, as a machine's start run ahead warms it: building its servers serves nothing, and the first agent's
  // requests after it are answered as every later one. What warming saves is the packages the first request would load
  // (`warm`), so that's what's counted: a time can't say it on a shared runner, where warmed and not differ by less
  // than the runner's own swings.
  await grants.warm()
  const grant = grants.mint("binding", "conversation")
  assert.ok(grant.computerUrl)
  const loaded: string[] = []
  const listening = onPackageLoad((load) => { if (load.state === "loading") loaded.push(`${load.name} for ${load.reason}`) })
  await agent.connect(new StreamableHTTPClientTransport(new URL(grant.computerUrl), {
    requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
  }))
  assert.deepEqual((await agent.listTools()).tools.map(t => t.name), ["js", "js_reset"])
  listening()
  assert.deepEqual(loaded, [], "the first agent's initialize and tools/list after warming load nothing warming didn't")
  const result = await agent.callTool({ name: "js", arguments: { code: 'await control.browsers()' } })
  assert.equal(result.isError, undefined, JSON.stringify(result))
  assert.match(JSON.stringify(result), /Mako browser and computer use/)
  const retained = await agent.callTool({ name: "js", arguments: { code: 'let retained=41; retained' } })
  assert.equal(retained.isError, undefined)
  const resumed = await agent.callTool({ name: "js", arguments: { code: '++retained' } })
  assert.match(JSON.stringify(resumed), /42/)
  const interrupted = new AbortController()
  const running = agent.callTool({ name: "js", arguments: { code: 'await new Promise(r=>setTimeout(r,5000)); state.tooLate=true' } }, undefined, { signal: interrupted.signal })
  await delay(100)
  interrupted.abort()
  await assert.rejects(running)
  const recovered = await agent.callTool({ name: "js", arguments: { code: 'typeof retained' } })
  assert.equal(recovered.isError, undefined, JSON.stringify(recovered))
  assert.match(JSON.stringify(recovered), /undefined/)
  assert.match(JSON.stringify(recovered), /Program state was reset/)
  assert.doesNotMatch(JSON.stringify(recovered), /Mako browser and computer use/, "documentation is printed once per session")
  await run(launch.command, ["connect", "--browser", "fixture"])
  await run(launch.command, ["open", "--browser", "fixture"])
  assert.equal(fixture.targets.size, 1)
  const lateFailure = await agent.callTool({ name: "js", arguments: { code: 'let survivor = "kept"; setTimeout(()=>{throw Error("late fixture callback")},100); "scheduled"' } })
  assert.equal(lateFailure.isError, undefined)
  await delay(300)
  const afterLateFailure = await agent.callTool({ name: "js", arguments: { code: 'await control.browsers(); survivor' } })
  assert.equal(afterLateFailure.isError, undefined, JSON.stringify(afterLateFailure))
  assert.match(JSON.stringify(afterLateFailure), /its callbacks threw; bindings and state were kept: late fixture callback/)
  assert.match(JSON.stringify(afterLateFailure), /late fixture callback\\nkept"/, "a late callback failure keeps REPL bindings")
  assert.equal(fixture.targets.size, 1, "An idle program fault must not close the task's targets")
  assert.ok(sessions.get("binding"), "An idle Worker error must not kill the desktop owner")
  const { bindings, spare } = await sessions.processes()
  assert.ok(bindings.binding, "the first call started the binding's worker")
  assert.ok(spare && spare !== bindings.binding, "and a spare waits for the next task")
  process.kill(bindings.binding, "SIGKILL")
  const deadline = Date.now() + 10000
  while (fixture.targets.size > 0 || reasons.length === 0) {
    assert.ok(
      Date.now() < deadline,
      "Lost worker must release browser ownership"
    )
    await delay(20)
  }
  assert.deepEqual(reasons, ["failed"])
  assert.equal(sessions.get("binding"), undefined)
  const gone = await agent.callTool({ name: "js", arguments: { code: 'await control.browsers()' } })
  assert.equal(gone.isError, true)
  assert.match(JSON.stringify(gone), /session-closed/)
  grants.revoke("binding", "conversation")
  await assert.rejects(agent.listTools(), {code:401})
  await sessions.close()
  await assert.rejects(sessions.start("late"), /closing/)
  applyControlEnvironment(env)
  assert.equal(env.MAKO_CONTROL_SESSION_FILE, undefined)
  console.log(
    "Desktop owner: real HTTP MCP persistent bindings, routed cancellation, revoked/failed task refusal, shared worker cleanup and credential isolation"
  )
} finally {
  await agent.close()
  grants.close()
  await sessions.close()
  await service.close()
  browsers.close()
  await fixture.close()
}

/** A resident provider can work across days without reopening its process or changing its environment's token. */
async function longLivedTools() {
  let now = Date.now()
  let running = true
  const clock = mock.method(Date, "now", () => now)
  const current = new Map([["first", "one"], ["sdk", "two"], ["ended", "old"], ["next", "three"]])
  const reports: string[] = []
  const server = await startConversationMcp({
    authorizeAgent(conversation, binding) {
      if (!running || current.get(binding) !== conversation) throw new Error("The binding no longer owns a running turn in this conversation")
    },
  }, async () => { throw new Error("No computer operation was requested") }, [
    (mcp, conversation) => mcp.registerTool("report_fixture", { description: "Record this fixture's report", inputSchema: {} }, async () => {
      const id = conversation()
      reports.push(id)
      return { content: [{ type: "text", text: id }] }
    }),
  ], () => ({ allowed: true }))
  const http = new Client({ name: "long-running-fin", version: "1" })
  const sdk = new Client({ name: "in-process-fin", version: "1" })
  const replacement = new Client({ name: "replacement-fin", version: "1" })
  let closed = false
  const first = server.mint("first", "one")
  const embedded = server.mint("sdk", "two")
  const ended = server.mint("ended", "old")
  const call = async (client: Client, expected: string) => {
    const before = reports.length
    const result = await client.callTool({ name: "report_fixture", arguments: {} })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    assert.deepEqual(reports.slice(before), [expected], "renewing a grant executes only the requested report once")
  }
  try {
    await http.connect(new StreamableHTTPClientTransport(new URL(first.makoUrl!), { requestInit: { headers: { Authorization: `Bearer ${first.token}` } } }))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const mako = await embedded.makoServer!()
    await mako.connect(serverTransport)
    await sdk.connect(clientTransport)
    await call(http, "one")
    await call(sdk, "two")
    now += 25 * 60 * 60_000
    await assert.doesNotReject(() => call(http, "one"), "the same current HTTP grant reports after 25 hours")
    await assert.doesNotReject(() => call(sdk, "two"), "the same current SDK grant reports after 25 hours")
    // The real owner refuses operations between turns. Another Fin starting must not retire that idle binding.
    now += 25 * 60 * 60_000
    running = false
    current.delete("ended")
    server.revoke("ended", "old")
    server.mint("next", "three")
    assert.ok((await http.listTools()).tools.some(tool => tool.name === "report_fixture"))
    const idleCount = reports.length
    assert.equal((await http.callTool({ name: "report_fixture", arguments: {} })).isError, true, "keeping an idle credential does not authorize an idle report")
    assert.equal(reports.length, idleCount)
    running = true
    await call(http, "one")
    await call(sdk, "two")
    const post = (url: string, token: string, body: object) => fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    assert.equal((await post(ended.makoUrl!, ended.token, {})).status, 401, "an ended binding is revoked")
    current.set("ended", "old")
    assert.equal((await post(ended.makoUrl!, ended.token, {})).status, 401, "a later mint does not recreate a retired credential")
    assert.equal((await post(first.makoUrl!, "fixture-unminted", {})).status, 401, "an unknown credential never renews")
    now += 25 * 60 * 60_000
    const gated = await post(first.makoUrl!.replace(/\/mako$/, "/calls/pre"), first.token, {})
    assert.equal(gated.status, 200, "native call hooks use the same active grant")
    assert.deepEqual(await gated.json(), { allowed: true })
    // A current binding check, not possession of an old token, is the authority for each operation.
    current.set("first", "replacement")
    now += 25 * 60 * 60_000
    const before = reports.length
    assert.equal((await http.callTool({ name: "report_fixture", arguments: {} })).isError, true)
    assert.equal(reports.length, before)
    server.revoke("first", "one")
    current.set("first", "one")
    assert.equal((await post(first.makoUrl!, first.token, {})).status, 401, "a revoked credential cannot later regain its old binding")
    await call(sdk, "two")
    server.revoke("sdk", "two")
    const revoked = await sdk.callTool({ name: "report_fixture", arguments: {} })
    assert.equal(revoked.isError, true, "the retained in-process server cannot renew an explicitly revoked grant")
    assert.equal(reports.length, before + 1, "neither failed nor revoked calls publish another report")
    assert.equal((await post(embedded.makoUrl!, embedded.token, {})).status, 401)
    const fresh = server.mint("sdk", "two")
    const [freshClient, freshServer] = InMemoryTransport.createLinkedPair()
    await (await fresh.makoServer!()).connect(freshServer)
    await replacement.connect(freshClient)
    await call(replacement, "two")
    server.close()
    closed = true
    const afterClose = await replacement.callTool({ name: "report_fixture", arguments: {} })
    assert.equal(afterClose.isError, true, "closing the listener also ends its retained SDK grants")
    assert.equal(reports.length, before + 2)
    console.log("Task tools: HTTP, SDK and hook grants survive days, idle turns and other mints; idle, ended, replaced, revoked and unknown callers cannot report")
  } finally {
    await Promise.all([http.close(), sdk.close(), replacement.close()])
    if (!closed) server.close()
    clock.mock.restore()
  }
}
