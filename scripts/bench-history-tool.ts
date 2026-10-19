import { performance } from "node:perf_hooks"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Entry } from "@mako/sessions/entries"
import { registerThreadHistoryTools, threadHistoryTools, type ThreadHistoryInput } from "@mako/host/conversations/thread-history"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"
import type { LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"

/**
 * What `thread_history` costs an agent's call on conversations shaped like
 * long agent work: a prompt, then thinking, replies and tool calls, about
 * 25 entries a turn, outputs mostly short with a tail of long ones (as
 * Codex and Claude sessions measure: most of a large session is tool
 * output). Each action is timed on 1k, 10k and 50k entries, in process and
 * once through the real `mako` server over HTTP, with the heap the reader
 * adds. `npm run bench:history-tool` (`--sizes 1000,10000`).
 */

const sizes = (process.argv.find((arg) => arg.startsWith("--sizes="))?.slice(8) ?? "1000,10000,50000").split(",").map(Number)
const RUNS = 7

/** A deterministic pseudo-random stream, so every run measures the same conversation. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31
    return state / 2 ** 31
  }
}

const WORDS = "the parser tokenizer cache request worker journal thread session binding stream record catalog render build index query merge fork branch commit test fails passes error retry timeout config module export import async await promise buffer chunk line".split(" ")
function prose(next: () => number, words: number): string {
  const out: string[] = []
  for (let index = 0; index < words; index++) out.push(WORDS[Math.floor(next() * WORDS.length)]!)
  return out.join(" ")
}
function output(next: () => number, chars: number): string {
  const lines: string[] = []
  let size = 0
  while (size < chars) {
    const line = `${prose(next, 6 + Math.floor(next() * 10))} ${Math.floor(next() * 1e6)}`
    lines.push(line)
    size += line.length + 1
  }
  return lines.join("\n")
}

function conversation(total: number): Entry[] {
  const next = random(total)
  const entries: Entry[] = []
  let turn = 0
  const at = Date.UTC(2026, 9, 1)
  while (entries.length < total) {
    turn++
    entries.push({ type: "user", requestId: `r${turn}`, text: `Turn ${turn}: ${prose(next, 12 + Math.floor(next() * 40))}`, at: at + entries.length * 1_000 })
    const steps = 18 + Math.floor(next() * 14)
    for (let step = 0; step < steps && entries.length < total; step++) {
      const kind = next()
      const id = `e${entries.length}`
      const time = at + entries.length * 1_000
      if (kind < 0.15) entries.push({ type: "thinking", id, text: prose(next, 40 + Math.floor(next() * 200)), at: time })
      else if (kind < 0.35) entries.push({ type: "text", id, text: prose(next, 20 + Math.floor(next() * 120)), at: time })
      else {
        const size = next() < 0.01 ? 100_000 + Math.floor(next() * 200_000) : next() < 0.1 ? 5_000 + Math.floor(next() * 20_000) : 100 + Math.floor(next() * 1_500)
        const name = ["Bash", "Read", "Edit", "Grep"][Math.floor(next() * 4)]!
        entries.push({ type: "tool", id, name, status: "completed", input: JSON.stringify({ command: prose(next, 6), timeout: 120 }), output: output(next, size), at: time })
      }
    }
  }
  entries.push({ type: "text", id: "rare", text: "The decision: keep the zeppelin-cache behind a flag.", at: at + entries.length * 1_000 })
  return entries
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

const heap = () => {
  globalThis.gc?.()
  return process.memoryUsage().heapUsed
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

for (const total of sizes) {
  const entries = conversation(total)
  const chars = entries.reduce((sum, entry) => sum + (entry.type === "tool" ? (entry.input?.length ?? 0) + (entry.output?.length ?? 0) : "text" in entry ? entry.text.length : 0), 0)
  const id = "bench"
  let revision = 1
  const summary = { session: { id, harness: "codex", nativeId: "n", cwd: "/tmp", status: "running", connection: "connected", modes: [], currentMode: null, configOptions: [] }, revision, createdAt: 0 } satisfies LiveSummary
  // Each call sees a new revision, as a running turn's does: nothing is cached across calls but native sessions read whole.
  const snapshot = async (): Promise<LiveSnapshot> => ({ ...summary, revision: ++revision, blocks: entries, base: null, permissions: [], requests: [] })
  const before = heap()
  const tools = threadHistoryTools({
    conversations: () => [summary],
    snapshot,
    store: () => null,
    catalog: { list: () => [], nativePath: () => undefined, ref: () => undefined, open: async () => null, entry: async () => null },
  })
  const turns = entries.filter((entry) => entry.type === "user").length
  const middle = Math.floor(turns / 2)
  const bigTurn = (() => {
    let turn = 0
    for (const entry of entries) {
      if (entry.type === "user") turn++
      if (entry.type === "tool" && (entry.output?.length ?? 0) > 100_000) return turn
    }
    return middle
  })()
  const cases: Array<[string, ThreadHistoryInput]> = [
    ["turns (newest 80)", { action: "turns" }],
    ["turns 1-80", { action: "turns", turns: "1-80" }],
    ["read newest turn", { action: "read" }],
    [`read turn ${middle}`, { action: "read", turns: String(middle) }],
    ["search rare text (whole scan)", { action: "search", query: "zeppelin-cache" }],
    ["search common word", { action: "search", query: "tokenizer" }],
    ["search regex", { action: "search", query: "retry\\s+timeout\\s+\\w+", regex: true }],
    ["search no match", { action: "search", query: "nothing-matches-this" }],
  ]
  const ref = (await tools.answer(id, { action: "read", turns: String(bigTurn) })).match(/payload ref="([^"]+)"/)?.[1]
  if (ref) cases.push(["payload page of a 100k+ output", { action: "payload", ref }])
  console.log(`\n${total.toLocaleString("en-US")} entries, ${turns.toLocaleString("en-US")} turns, ${(chars / 1024 / 1024).toFixed(1)} M chars`)
  for (const [name, input] of cases) {
    const times: number[] = []
    let size = 0
    for (let run = 0; run < RUNS; run++) {
      const start = performance.now()
      size = (await tools.answer(id, input)).length
      times.push(performance.now() - start)
    }
    console.log(`  ${name.padEnd(34)} ${median(times).toFixed(1).padStart(7)} ms  (max ${Math.max(...times).toFixed(1)}, reply ${size.toLocaleString("en-US")} chars)`)
  }
  console.log(`  heap the reader keeps:             ${mb(Math.max(0, heap() - before))}`)

  // The same calls as an agent makes them: the real server, a minted grant, HTTP.
  const servers = await startConversationMcp({ authorizeAgent: () => {} }, async () => ({ content: [] }), [(server, conversationId) => registerThreadHistoryTools(server, tools, conversationId)])
  const grant = servers.mint("binding", id)
  const agent = new Client({ name: "bench", version: "1" })
  await agent.connect(new StreamableHTTPClientTransport(new URL(grant.makoUrl!), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }))
  for (const [name, input] of [cases[0]!, cases[2]!, cases[4]!]) {
    const times: number[] = []
    for (let run = 0; run < RUNS; run++) {
      const start = performance.now()
      await agent.callTool({ name: "thread_history", arguments: { ...input } })
      times.push(performance.now() - start)
    }
    console.log(`  over HTTP: ${name.padEnd(23)} ${median(times).toFixed(1).padStart(7)} ms`)
  }
  await agent.close()
  servers.close()
}
