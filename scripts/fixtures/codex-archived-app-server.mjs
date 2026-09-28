// A Codex app-server whose thread sits in Codex's archive, answering the way
// codex 0.154 does: `thread/resume` is refused until `thread/unarchive`, which
// the test asserts Mako never sends.
// MAKO_CODEX_ARCHIVED_LOG names a file that receives each method called.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const log = process.env.MAKO_CODEX_ARCHIVED_LOG
const missing = process.env.MAKO_CODEX_ARCHIVED_MISSING === "1"
let archived = true

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const refuse = (id, message) => send({ id, error: { code: -32600, message } })

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  if (log) appendFileSync(log, `${method}\n`)
  switch (method) {
    case "initialize": return send({ id, result: {} })
    case "thread/resume":
      if (missing) return refuse(id, `no rollout found for thread id ${params.threadId}`)
      if (archived) return refuse(id, `session ${params.threadId} is archived. Run \`codex unarchive ${params.threadId}\` to unarchive it first.`)
      return send({ id, result: { thread: { id: params.threadId, cwd: params.cwd } } })
    case "thread/unarchive":
      archived = false
      return send({ id, result: { thread: { id: params.threadId } } })
    case "thread/loaded/list": return send({ id, result: { data: [], nextCursor: null } })
    case "thread/backgroundTerminals/list": return send({ id, result: { data: [], nextCursor: null } })
    case "thread/backgroundTerminals/clean": return send({ id, result: {} })
    default: return send({ id, error: { code: -32601, message: `Unexpected ${method}` } })
  }
})
