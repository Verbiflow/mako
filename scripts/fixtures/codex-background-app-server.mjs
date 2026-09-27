// A Codex app-server that keeps terminals the way codex 0.154 does: an
// interrupt turns the running foreground command into one more terminal, and
// the app-server's exit leaves every terminal running.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const threadId = "thread-background"
const terminals = new Map()
let turn = 0
let foreground = null

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const notify = (method, params) => send({ method, params: { threadId, ...params } })
const command = (id, status) => ({ type: "commandExecution", id, command: "sleep 300", cwd: process.cwd(), status, aggregatedOutput: "", exitCode: null })
const completed = (turnId, status) => notify("turn/completed", { turn: { id: turnId, status, items: [], error: null } })
const message = (turnId, text) => {
  const item = { type: "agentMessage", id: `message-${turnId}`, text }
  notify("item/started", { turnId, item: { ...item, text: "" } })
  notify("item/agentMessage/delta", { turnId, itemId: item.id, delta: text })
  notify("item/completed", { turnId, item })
}
const sleep = (turnId, id) => {
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
  child.unref()
  notify("item/started", { turnId, item: command(id, "inProgress") })
  return child
}

function startTurn(id, text) {
  const turnId = `turn-${++turn}`
  send({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } })
  notify("turn/started", { turn: { id: turnId } })
  if (text === "start") {
    const itemId = `terminal-${turn}`
    const child = sleep(turnId, itemId)
    terminals.set(itemId, child)
    message(turnId, `background ${child.pid}`)
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

function interrupt(id) {
  send({ id, result: {} })
  const interrupted = foreground
  foreground = null
  if (!interrupted) return
  setTimeout(() => {
    terminals.set(interrupted.itemId, interrupted.child)
    completed(interrupted.turnId, "interrupted")
  }, 50)
}

function clean(id) {
  for (const [itemId, child] of terminals) {
    child.kill()
    notify("item/completed", { turnId: "clean", item: { ...command(itemId, "failed"), exitCode: -1 } })
  }
  terminals.clear()
  send({ id, result: {} })
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  switch (method) {
    case "initialize": return send({ id, result: {} })
    case "thread/start": return send({ id, result: { thread: { id: threadId, cwd: params.cwd } } })
    case "turn/start": return startTurn(id, params.input.find((part) => part.type === "text")?.text)
    case "turn/interrupt": return interrupt(id)
    case "thread/backgroundTerminals/list":
      return send({ id, result: { data: [...terminals].map(([itemId, child]) => ({ itemId, processId: String(child.pid), command: "sleep 300", cwd: process.cwd() })), nextCursor: null } })
    case "thread/backgroundTerminals/clean": return clean(id)
    default: return send({ id, error: { code: -32601, message: `Unexpected ${method}` } })
  }
})
