// No provider or model: exercises Mako's production app-server wire construction.
import { appendFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

let turn = 0
// The thread's rollout, as Codex writes it: a developer message for each application entry it hands the model (one
// that differs from the turn before's, `AdditionalContextStore::merge`), and a record for each compaction.
const rollout = process.env.PRIMER_ROLLOUT
let held = {}
const record = (value) => { if (rollout) appendFileSync(rollout, `${JSON.stringify(value)}\n`) }
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
  else if (frame.method === "thread/start" || frame.method === "thread/resume") {
    if (frame.method === "thread/start" && rollout) writeFileSync(rollout, "")
    reply({ thread: { id: "fixture-thread", cwd: process.cwd(), ...rollout && { path: rollout } }, model: "fixture" })
  }
  else if (frame.method === "turn/start" || frame.method === "thread/compact/start") {
    const id = `turn-${++turn}`
    if (frame.method === "turn/start") {
      const context = frame.params.additionalContext ?? {}
      for (const [key, entry] of Object.entries(context))
        if (held[key]?.value !== entry.value)
          record({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }] } })
      held = context
      record({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: frame.params.input.map(item => item.text).join("") }] } })
    } else record({ type: "compacted", payload: { message: "", replacement_history: [] } })
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
