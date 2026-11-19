// No provider or model: exercises Mako's production app-server wire construction.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

let turn = 0
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`)
createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line)
  appendFileSync(process.env.PRIMER_CALLS, `${JSON.stringify(frame)}\n`)
  if (frame.id === undefined) return
  const reply = result => process.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`)
  if (frame.method === "initialize") reply({ userAgent: "fixture/1.0" })
  else if (frame.method === "account/read") reply({ account: null })
  else if (frame.method === "thread/backgroundTerminals/list") reply({ data: [], nextCursor: null })
  else if (frame.method === "thread/backgroundTerminals/clean") reply({})
  else if (frame.method === "thread/loaded/list") reply({ data: [], nextCursor: null })
  else if (frame.method === "thread/unsubscribe") reply({ status: "unsubscribed" })
  else if (frame.method === "thread/start" || frame.method === "thread/resume") reply({ thread: { id: "fixture-thread", cwd: process.cwd() }, model: "fixture" })
  else if (frame.method === "turn/start" || frame.method === "thread/compact/start") {
    const id = `turn-${++turn}`
    reply({ turn: { id, items: [], status: "inProgress", error: null } })
    notify("turn/started", { threadId: "fixture-thread", turn: { id, items: [], status: "inProgress" } })
    if (frame.method === "thread/compact/start") notify("item/completed", { threadId: "fixture-thread", turnId: id, item: { type: "contextCompaction", id: "compaction" } })
    notify("turn/completed", { threadId: "fixture-thread", turn: { id, items: [], status: "completed", error: null } })
  } else if (frame.method === "turn/interrupt") {
    reply({})
    notify("turn/completed", { threadId: "fixture-thread", turn: { id: `turn-${turn}`, items: [], status: "interrupted", error: null } })
  } else {
    throw new Error(`Unexpected fixture request ${frame.method}`)
  }
})
