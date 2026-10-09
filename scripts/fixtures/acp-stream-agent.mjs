// An ACP agent that streams one long turn at a model's pace, for measuring the
// host under load: a few words every MEASURE_CHUNK_MS, a thought now and then,
// and a shell command with a page of output every two seconds.
import { randomUUID } from "node:crypto"
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"

const sessionId = randomUUID()
const duration = Number(process.env.MEASURE_STREAM_MS ?? 20_000)
const interval = Number(process.env.MEASURE_CHUNK_MS ?? 20)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const words = "the host reads each update decodes it journals it and sends it to every window watching".split(" ")
const output = Array.from({ length: 40 }, (_, line) => `line ${line}: ${words.join(" ")}`).join("\n")
let cancelled = false

new AgentSideConnection((connection) => {
  const update = (value) => connection.sessionUpdate({ sessionId, update: value })
  return {
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: { loadSession: false } }
    },
    async newSession() {
      return { sessionId }
    },
    async authenticate() {
      return {}
    },
    async setSessionMode() {
      return {}
    },
    async prompt() {
      cancelled = false
      const began = Date.now()
      let step = 0
      while (!cancelled && Date.now() - began < duration) {
        step++
        const text = Array.from({ length: 4 }, (_, index) => words[(step * 4 + index) % words.length]).join(" ")
        await update({ sessionUpdate: step % 25 === 0 ? "agent_thought_chunk" : "agent_message_chunk", content: { type: "text", text: `${text} ` } })
        if (step % Math.round(2000 / interval) === 0) {
          const toolCallId = `run-${step}`
          await update({ sessionUpdate: "tool_call", toolCallId, title: `Run check ${step}`, kind: "execute", status: "in_progress", rawInput: { command: `npm test -- --shard ${step}` } })
          await pause(interval * 5)
          await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: output } }] })
        }
        await pause(interval)
      }
      return { stopReason: cancelled ? "cancelled" : "end_turn" }
    },
    async cancel() {
      cancelled = true
    },
  }
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
