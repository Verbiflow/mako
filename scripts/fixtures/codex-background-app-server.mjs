// A Codex app-server that keeps terminals and subagents the way codex 0.154
// does: an interrupt turns the running foreground command into one more
// terminal of its thread, a subagent is another loaded thread whose turn
// outlives its parent's, and the app-server's exit leaves all of it running.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const threadId = "thread-background"
const terminals = new Map([[threadId, new Map()]])
const subagents = new Map()
let turn = 0
let foreground = null

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const notify = (method, params) => send({ method, params: { threadId, ...params } })
const command = (id, status) => ({ type: "commandExecution", id, command: "sleep 300", cwd: process.cwd(), status, aggregatedOutput: "", exitCode: null })
const completed = (turnId, status, thread = threadId) => notify("turn/completed", { threadId: thread, turn: { id: turnId, status, items: [], error: null } })
const message = (turnId, text) => {
  const item = { type: "agentMessage", id: `message-${turnId}`, text }
  notify("item/started", { turnId, item: { ...item, text: "" } })
  notify("item/agentMessage/delta", { turnId, itemId: item.id, delta: text })
  notify("item/completed", { turnId, item })
}
const sleep = (turnId, id, thread = threadId) => {
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
  child.unref()
  notify("item/started", { threadId: thread, turnId, item: command(id, "inProgress") })
  return child
}

function spawnSubagent(parentTurnId) {
  const thread = `thread-agent-${turn}`
  const turnId = `turn-agent-${turn}`
  notify("item/started", { turnId: parentTurnId, item: { type: "subAgentActivity", id: `activity-${turn}`, kind: "started", agentThreadId: thread, agentPath: "/root/sleeper" } })
  notify("turn/started", { threadId: thread, turn: { id: turnId } })
  terminals.set(thread, new Map())
  const agent = { turnId, status: "inProgress", itemId: `command-agent-${turn}`, child: null }
  agent.child = sleep(turnId, agent.itemId, thread)
  subagents.set(thread, agent)
  return agent.child
}

function startTurn(id, text) {
  const turnId = `turn-${++turn}`
  send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } })
  notify("turn/started", { turn: { id: turnId } })
  if (text === "start") {
    const itemId = `terminal-${turn}`
    const child = sleep(turnId, itemId)
    terminals.get(threadId).set(itemId, child)
    message(turnId, `background ${child.pid}`)
    completed(turnId, "completed")
  } else if (text === "spawn") {
    message(turnId, `subagent ${spawnSubagent(turnId).pid}`)
    completed(turnId, "completed")
  } else if (text === "work") {
    foreground = { turnId, itemId: `command-${turn}`, child: null }
    foreground.child = sleep(turnId, foreground.itemId)
    message(turnId, `foreground ${foreground.child.pid}`)
  } else {
    message(turnId, `answered ${text}`)
    completed(turnId, "completed")
  }
}

function interrupt(id, params) {
  send({ id, result: {} })
  const agent = subagents.get(params.threadId)
  if (agent) {
    if (agent.status !== "inProgress" || agent.turnId !== params.turnId) return
    setTimeout(() => {
      agent.status = "interrupted"
      terminals.get(params.threadId).set(agent.itemId, agent.child)
      completed(agent.turnId, "interrupted", params.threadId)
    }, 50)
    return
  }
  const interrupted = foreground
  foreground = null
  if (!interrupted) return
  setTimeout(() => {
    terminals.get(threadId).set(interrupted.itemId, interrupted.child)
    completed(interrupted.turnId, "interrupted")
  }, 50)
}

function clean(id, thread) {
  for (const [itemId, child] of terminals.get(thread) ?? []) {
    child.kill()
    notify("item/completed", { threadId: thread, turnId: "clean", item: { ...command(itemId, "failed"), exitCode: -1 } })
  }
  terminals.get(thread)?.clear()
  send({ id, result: {} })
}

function turns(id, thread) {
  const agent = subagents.get(thread)
  send({ id, result: { data: agent ? [{ id: agent.turnId, status: agent.status, itemsView: "notLoaded", items: [] }] : [] } })
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  switch (method) {
    case "initialize": return send({ id, result: {} })
    case "thread/start": return send({ id, result: { thread: { id: threadId, cwd: params.cwd } } })
    case "turn/start": return startTurn(id, params.input.find((part) => part.type === "text")?.text)
    case "turn/interrupt": return interrupt(id, params)
    case "thread/loaded/list": return send({ id, result: { data: [threadId, ...subagents.keys()], nextCursor: null } })
    case "thread/turns/list": return turns(id, params.threadId)
    case "thread/backgroundTerminals/list":
      return send({ id, result: { data: [...terminals.get(params.threadId) ?? []].map(([itemId, child]) => ({ itemId, processId: String(child.pid), command: "sleep 300", cwd: process.cwd() })), nextCursor: null } })
    case "thread/backgroundTerminals/clean": return clean(id, params.threadId)
    default: return send({ id, error: { code: -32601, message: `Unexpected ${method}` } })
  }
})
