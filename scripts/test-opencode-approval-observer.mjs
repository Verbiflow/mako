import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { prepareOpenCodeApprovals } from "../dist-electron/providers/opencode/approval-observer.js"

const root = await mkdtemp(join(tmpdir(), "mako-approval-observer-test-"))
const observers = []
try {
  const received = []
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: ["user-plugin"], model: "existing" }) }
  const observer = await prepareOpenCodeApprovals({ root, env, previous: [], publish: decision => received.push(decision) })
  observers.push(observer)
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
  assert.equal(config.model, "existing")
  assert.equal(config.plugins[0], "user-plugin")
  const path = config.plugins.at(-1).options.path
  assert.ok((await readFile(join(config.plugins.at(-1).package, "index.js"), "utf8")).includes("mako-native-approval-observer"))
  // OpenCode loads this copy outside Mako's module tree. A plain tsc output
  // importing zod passes host checks but fails here without the bundle step.
  const plugin = (await import(pathToFileURL(join(config.plugins.at(-1).package, "index.js")).href)).default
  assert.equal(plugin.id, "mako-native-approval-observer")
  const disposePlugin = await plugin.setup({ options: { path }, event: {
    async *subscribe() {
      yield { type: "permission.asked", data: { sessionID: "isolated", id: "permission", source: { id: "tool" } } }
      yield { type: "permission.replied", data: { sessionID: "isolated", requestID: "permission", reply: "reject" } }
    },
  } })
  await disposePlugin()
  const nativeRecords = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line))
  assert.deepEqual(nativeRecords[0], { type: "asked", sessionId: "isolated", requestId: "permission", toolId: "tool" })
  assert.equal(nativeRecords[1].reply, "reject")
  const asked = (sessionId, requestId, toolId) => ({ type: "asked", sessionId, requestId, toolId })
  const reply = (sessionId, requestId) => ({ type: "replied", sessionId, requestId, reply: "once", observedAt: 123 })
  const append = value => appendFile(path, JSON.stringify(value) + "\n")
  const request = (toolCallId, sessionId = "parent") => ({ sessionId, toolCall: { toolCallId }, options: [] })
  await append(asked("parent", "permission-1", "tool-1"))
  const first = await observer.identify(request("tool-1"))
  assert.equal(first.requestId, "permission-1")
  assert.equal(await observer.identify(request("missing")), undefined, "an unmapped tool never invents a native approval")
  await append(reply("wrong-session", "permission-1"))
  await delay(300)
  assert.equal(received.length, 0)
  const partial = JSON.stringify(reply("parent", "permission-1"))
  await appendFile(path, partial.slice(0, 20)); await delay(300)
  assert.equal(received.length, 0, "partial native records are not evidence")
  await appendFile(path, partial.slice(20) + "\n"); await delay(350)
  assert.deepEqual(received[0].identity, first)
  await append(asked("child", "permission-2", "tool-2"))
  const child = await observer.identify(request("child:tool-2"))
  assert.equal(child.sessionId, "child", "child ACP prefix maps to the native child session")
  await append(asked("parent", "ambiguous-a", "same-tool"))
  await append(asked("parent", "ambiguous-b", "same-tool"))
  assert.equal(await observer.identify(request("same-tool")), undefined, "two native requests for a tool cannot be guessed")
  await observer.dispose()
  await append(reply("child", "permission-2"))
  const recovered = []
  const reopened = await prepareOpenCodeApprovals({ root, env: {}, previous: [first, child], publish: decision => recovered.push(decision) })
  observers.push(reopened)
  assert.deepEqual(recovered.map(item => item.identity), [first, child], "retained exact decisions survive observer replacement")
  assert.equal(received.length, 1, "the disposed observer cannot publish the later record")
  const malformedEnv = {}
  const invalid = await prepareOpenCodeApprovals({ root, env: malformedEnv, previous: [], publish() { throw Error("Invalid evidence was published") } })
  observers.push(invalid)
  const malformedPath = JSON.parse(malformedEnv.OPENCODE_CONFIG_CONTENT).plugins.at(-1).options.path
  await writeFile(malformedPath, JSON.stringify(asked("parent", "old", "old-tool")) + "\nnot-json\n")
  assert.equal(await invalid.identify(request("old-tool")), undefined)
  await writeFile(malformedPath, "x".repeat(1_048_577))
  assert.equal(await invalid.identify(request("old-tool")), undefined, "oversized evidence remains unverified")
  const historyEnv = {}
  const history = await prepareOpenCodeApprovals({ root, env: historyEnv, previous: [], publish() {} })
  observers.push(history)
  const historyPath = JSON.parse(historyEnv.OPENCODE_CONFIG_CONTENT).plugins.at(-1).options.path
  const records = Array.from({length: 2000}, (_, i) => [asked('parent', 'history-'+i, 'tool-'+i), reply('parent', 'history-'+i)]).flat()
  records.push(asked('parent','latest','latest-tool'))
  await writeFile(historyPath, records.map(record=>JSON.stringify(record)).join('\n')+'\n')
  const start = performance.now()
  assert.equal((await history.identify(request('latest-tool')))?.requestId,'latest')
  console.log(`Retained evidence: 2000 decisions, ${records.length} records; correlation ${(performance.now()-start).toFixed(1)} ms`)
  console.log("PASS OpenCode observer: config preservation, exact/child IDs, ambiguity, partial/corrupt records, retained reconnect, bounded reads, disposal")
} finally {
  await Promise.all(observers.map(observer => observer.dispose()))
  await rm(root, { recursive: true, force: true })
}
