import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startConversationMcp } from "../electron/conversation-mcp.js"
import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { ControlSessions } from "../electron/control-sessions.js"
import { startControlService } from "../electron/control-service.js"
import { BrowserService } from "../packages/control-runtime/src/browser-service.js"
import { browserFixture } from "./browser-control-fixture.js"
import {
  applyControlEnvironment,
  controlLaunchInstructions,
} from "../electron/control-launch.js"
const run = promisify(execFile)
const fixture = await browserFixture()
const browsers = new BrowserService([fixture.definition])
const service = await startControlService(browsers, () => {})
const sessions = new ControlSessions(async () => undefined)
const reasons: string[] = []
const grants = await startConversationMcp({
  authorizeAgent: (conversationId, bindingId) => { assert.equal(conversationId, "conversation"); assert.equal(bindingId, "binding") },
  availableProviders: () => [], delegate: async () => {}, childTasks: () => [], cancelChild: () => {},
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
  assert.ok(controlLaunchInstructions(launch).includes(launch.command))
  const grant = grants.mint("binding", "conversation")
  assert.ok(grant.controlUrl)
  await agent.connect(new StreamableHTTPClientTransport(new URL(grant.controlUrl), {
    requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
  }))
  assert.deepEqual((await agent.listTools()).tools.map(t => t.name), ["js", "js_reset"])
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
  assert.match(JSON.stringify(recovered), /Mako browser and computer use/)
  await run(launch.command, ["connect", "--browser", "fixture"])
  await run(launch.command, ["open", "--browser", "fixture"])
  assert.equal(fixture.targets.size, 1)
  const lateFailure = await agent.callTool({ name: "js", arguments: { code: 'setTimeout(()=>{throw Error("late fixture callback")},100); "scheduled"' } })
  assert.equal(lateFailure.isError, undefined)
  await delay(300)
  const afterLateFailure = await agent.callTool({ name: "js", arguments: { code: 'await control.browsers()' } })
  assert.equal(afterLateFailure.isError, undefined, JSON.stringify(afterLateFailure))
  assert.match(JSON.stringify(afterLateFailure), /Mako browser and computer use/)
  assert.equal(fixture.targets.size, 1, "An idle program fault must not close the task's targets")
  assert.ok(sessions.get("binding"), "An idle Worker error must not kill the desktop owner")
  const descriptor = JSON.parse(await readFile(launch.sessionFile, "utf8"))
  process.kill(descriptor.pid, "SIGKILL")
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
