import assert from "node:assert/strict"
import { ConversationView, MakoClient } from "../dist/index.js"

/**
 * The headless client against a host that answers its calls and sends its events as a host does: a conversation
 * started, its turn watched as it streams (text, a tool, a question), answered, steered, stopped, and read back, with
 * the batches the reducer applies in order and a reread when the host says history changed.
 */
class FakeHost {
  where = "fake"
  calls = []
  listeners = new Set()
  revision = 1
  constructor() {
    this.snapshot = { revision: 1, epoch: "e1", blocks: [], requests: [], permissions: [], session: {} }
  }
  async call(channel, args) {
    this.calls.push([channel, args])
    if (channel === "mako:live-start") {
      const [, , init] = args
      this.conversation = init.conversationId
      this.snapshot.requests = init.initialRequest ? [{ id: init.initialRequest.id, status: "dispatching" }] : []
      return { id: init.conversationId }
    }
    if (channel === "mako:live-snapshot") return structuredClone(this.snapshot)
    if (channel === "mako:live-prompt") {
      this.snapshot.requests.push({ id: args[1], status: "queued" })
      return null
    }
    return { kind: "completed" }
  }
  events(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  close() {}
  batch(fields) {
    this.revision += 1
    const batch = { id: this.conversation, revision: this.revision, epoch: "e1", updates: [], ...fields }
    for (const listener of this.listeners) listener({ type: "live-batch", batch })
  }
}

const host = new FakeHost()
const client = new MakoClient(host)
const started = await client.start({ harness: "claude", cwd: "/work", text: "Read the parser" })
assert.equal(host.calls[0][0], "mako:live-start")
assert.deepEqual(host.calls[0][1].slice(0, 2), ["claude", "/work"])
assert.equal(host.calls[0][1][2].initialRequest.text, "Read the parser")

const seen = []
const turn = client.turn(started.conversationId, started.requestId, (change) => seen.push(change))
await new Promise((resolve) => setImmediate(resolve))
host.batch({ updates: [{ kind: "text", id: "t1", text: "The par" }] })
host.batch({ updates: [{ kind: "text", id: "t1", text: "ser exports one function." }] })
host.batch({ revision: 2, updates: [{ kind: "text", id: "t1", text: "IGNORED" }] }) // an older revision than the view holds
host.batch({ updates: [{ kind: "tool", id: "c1", title: "Read parser.ts", status: "in_progress" }] })
host.batch({ updates: [{ kind: "tool-update", id: "c1", status: "completed", output: "export function parse() {}" }] })
host.batch({ permissions: [{ id: "q1", sessionId: "s", title: "Run tests?", options: [{ optionId: "yes", name: "Yes" }, { optionId: "no", name: "No" }] }] })
host.batch({ requestChanges: [{ id: started.requestId, status: "completed" }] })
const settled = await turn
assert.equal(settled?.status, "completed")
assert.deepEqual(seen.filter((change) => change.kind === "text").map((change) => change.text), ["The par", "ser exports one function."], "only what each batch added, in order; a stale revision is passed over")
assert.deepEqual(seen.filter((change) => change.kind === "tool").map((change) => [change.title, change.state]), [["Read parser.ts", "started"], ["Read parser.ts", "done"]])
assert.equal(seen.find((change) => change.kind === "question")?.permission.id, "q1")

// Answer, steer, stop and send go to the host as its own calls.
await client.answer(started.conversationId, "q1", "yes")
await client.steer(started.conversationId, started.requestId, "only the public API")
await client.stop(started.conversationId)
const { requestId: second } = await client.send(started.conversationId, "And the tests?")
assert.deepEqual(host.calls.slice(-4).map(([channel]) => channel), ["mako:live-permission", "mako:live-action", "mako:live-cancel", "mako:live-prompt"])
assert.deepEqual(host.calls.at(-4)[1], [started.conversationId, "q1", { kind: "choice", optionId: "yes" }])
assert.equal(host.calls.at(-3)[1][1].kind, "steer")
assert.equal(host.calls.at(-1)[1][1], second)

// History the batches don't carry: the client reads the conversation again and goes on from it.
host.snapshot = { revision: 50, epoch: "e1", blocks: [{ type: "text", id: "t9", text: "rewritten" }], requests: [{ id: second, status: "dispatching" }], permissions: [], session: {} }
const after = []
const next = client.turn(started.conversationId, second, (change) => after.push(change))
await new Promise((resolve) => setImmediate(resolve))
host.revision = 50
host.batch({ historyChanged: true })
host.batch({ updates: [{ kind: "text", id: "t10", text: "Tests pass." }], requestChanges: [{ id: second, status: "completed" }] })
assert.equal((await next)?.status, "completed")
assert.deepEqual(after.filter((change) => change.kind === "text").map((change) => change.text), ["Tests pass."])

// A view prints a conversation from the start.
const view = new ConversationView("c", { revision: 1, blocks: [{ type: "user", id: "u", text: "hi" }, { type: "text", id: "a", text: "hello" }], requests: [], permissions: [], session: {} })
assert.deepEqual(view.history().map((change) => change.kind), ["user", "text"])
console.log("PASS: the headless client starts, watches, answers, steers, stops, sends and reads a conversation through the host's own calls and events")
