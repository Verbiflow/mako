// Live probe: does Codex native compaction retain the thread's history?
// Spawns the real `codex app-server`, runs one turn, compacts, resumes, and
// compares the turns the store still carries.
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"

const child = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
})
child.stderr.resume()

let buf = ""
let nextId = 1
const pending = new Map()
const seen = []

child.stdout.on("data", (chunk) => {
  buf += chunk.toString()
  let at
  while ((at = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, at)
    buf = buf.slice(at + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.method) {
      seen.push(msg.method)
      if (msg.id !== undefined)
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "probe refuses server requests" },
          }) + "\n"
        )
      console.log(
        "  [notification]",
        msg.method,
        msg.method === "error" || msg.method === "warning" || msg.method === "item/completed"
          ? JSON.stringify(msg.params).slice(0, 400)
          : ""
      )
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})

function rpc(method, params) {
  const id = nextId++
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
  )
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 240_000)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await rpc("initialize", {
  clientInfo: { name: "mako", title: "Mako", version: "0.0.1" },
  capabilities: { experimentalApi: true, requestAttestation: false },
})
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n")

const started = await rpc("thread/start", {
  cwd: tmpdir(),
  model: process.env.CODEX_PROBE_MODEL || "gpt-5.2",
})
const threadId = started.result?.thread?.id
if (!threadId) {
  console.error("thread/start failed:", JSON.stringify(started).slice(0, 500))
  process.exit(1)
}
console.log("thread:", threadId)

await rpc("turn/start", {
  threadId,
  input: [
    {
      type: "text",
      text: "Reply with the single word ACK. Do not use tools.",
    },
  ],
  cwd: tmpdir(),
})
console.log("turn started; waiting for turn/completed…")
for (let i = 0; i < 600 && !seen.includes("turn/completed"); i++) await sleep(500)
if (!seen.includes("turn/completed")) {
  console.error("the turn never completed; notifications seen:", [...new Set(seen)])
  process.exit(1)
}
console.log("turn completed")

const before = await rpc("thread/resume", { threadId, cwd: tmpdir() })
const turnsBefore = before.result?.thread?.turns?.length ?? -1
console.log("turns before compact:", turnsBefore)

seen.length = 0
await rpc("thread/compact/start", { threadId })
console.log("compact started; waiting for completion…")
for (
  let i = 0;
  i < 600 &&
  !seen.some((m) => m === "turn/completed" || m.includes("compact"));
  i++
)
  await sleep(500)
await sleep(1000)

const after = await rpc("thread/resume", { threadId, cwd: tmpdir() })
const turnsAfter = after.result?.thread?.turns ?? []
const itemsAfter = turnsAfter.reduce(
  (count, turn) => count + (turn.items?.length ?? 0),
  0
)
console.log("turns after compact:", turnsAfter.length, "| items:", itemsAfter)
for (const [index, turn] of turnsAfter.entries()) {
  const kinds = (turn.items ?? []).map(
    (item) => item.type ?? item.kind ?? "?"
  )
  console.log(`  turn ${index} [${turn.status ?? "?"}]: ${kinds.join(", ") || "no items"}`)
}
// Retention means the original exchange's items survive — not merely that a
// compaction record was added.
const original = turnsAfter[0]
const originalKinds = (original?.items ?? []).map(
  (item) => item.type ?? item.kind ?? "?"
)
const userKept = originalKinds.some((kind) => /user/i.test(kind))
const answerKept = originalKinds.some((kind) =>
  /assistant|agent|message|reasoning/i.test(kind)
)
console.log(
  userKept && answerKept
    ? "VERDICT: history retained — compaction can be advertised"
    : `VERDICT: history dropped — compaction stays unadvertised (original turn kinds: ${originalKinds.join(", ") || "none"})`
)
child.kill()
