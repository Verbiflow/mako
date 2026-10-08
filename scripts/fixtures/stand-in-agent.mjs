// The stand-in harness's agent (`stand-in-harness.mjs`): an ACP agent with
// a scripted model, so the session flows run against a seventh harness the
// way they run against a real CLI. It keeps each session in
// STAND_IN_STORE/<id>.jsonl, the updates it sent, which `session/load`
// replays, and holds <id>.pid while a process has the session open.
//
// The model reads the flows' own prompts: it remembers a marker and recalls
// it, runs `sleep N` as a terminal tool that Stop cancels, folds a message
// sent into a running turn into its reply, counts the flows' image when the
// bytes arrive intact, and in Plan proposes a plan it builds once approved.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, RequestError, ndJsonStream } from "@agentclientprotocol/sdk"
import { imageFixture } from "../provider-e2e-fixtures.mjs"

const store = process.env.STAND_IN_STORE
if (!store) throw new Error("STAND_IN_STORE names the stand-in's session store")
const MODES = { currentModeId: "full", availableModes: [{ id: "full", name: "Full access" }, { id: "plan", name: "Plan" }] }
// Restated whole at every turn, as devin 3000.10.23 restates its 841 models.
const OPTIONS = [{
  id: "model", name: "Model", type: "select", category: "model", currentValue: "stand-in",
  options: [{ value: "stand-in", name: "Stand-in" }, { value: "stand-in-large", name: "Stand-in Large" }],
}]
const IMAGE = imageFixture().toString("base64")
const PLAN_STEP = "1. Write"

const file = (sessionId) => join(store, `${sessionId}.jsonl`)
const lock = (sessionId) => join(store, `${sessionId}.pid`)
const held = new Set()
process.on("exit", () => { for (const sessionId of held) rmSync(lock(sessionId), { force: true }) })

/** What a session said before: each saved update, in order. */
function saved(sessionId) {
  if (!existsSync(file(sessionId))) return []
  return readFileSync(file(sessionId), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).params.update)
}

function open(sessionId) {
  if (existsSync(lock(sessionId))) {
    const pid = Number(readFileSync(lock(sessionId), "utf8"))
    if (pid !== process.pid && alive(pid)) throw new RequestError(-32000, `Session ${sessionId} is open in process ${pid}`)
  }
  writeFileSync(lock(sessionId), String(process.pid))
  held.add(sessionId)
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

new AgentSideConnection((client) => {
  const sessions = new Map()
  const keep = (session, update) =>
    appendFileSync(file(session.id), `${JSON.stringify({ method: "session/update", params: { sessionId: session.id, update } })}\n`)
  const send = async (session, update) => {
    keep(session, update)
    await client.sessionUpdate({ sessionId: session.id, update })
  }
  const say = (session, text) => send(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
  const session = (sessionId) => {
    const found = sessions.get(sessionId)
    if (!found) throw RequestError.resourceNotFound(sessionId)
    return found
  }

  /** One turn: what the person asked, read outside the notes Mako adds for the model. */
  async function turn(current, prompt) {
    const text = prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n")
    keep(current, { sessionUpdate: "user_message_chunk", content: { type: "text", text } })
    return answer(current, prompt, text.replace(/<mako-local-control>[\s\S]*?<\/mako-local-control>/g, ""))
  }

  async function answer(current, prompt, text) {
    const image = prompt.find((block) => block.type === "image")
    if (image) return say(current, image.data === IMAGE ? "red 4, blue 2" : "The image did not arrive intact.")
    const sleep = /sleep (\d+)/.exec(text)
    if (sleep) {
      const done = await terminal(current, Number(sleep[1]))
      if (!done) return "cancelled"
      return say(current, ["DONE", ...current.running.steers.map(steered)].join(" "))
    }
    if (current.mode === "plan") return plan(current, text)
    if (/implement the plan/i.test(text)) return build(current)
    const remember = /Remember the marker (\S+?)\./.exec(text)
    if (remember) return say(current, "ACK")
    if (/what marker/i.test(text)) return say(current, recall(current, /Remember the marker (\S+?)\./) ?? "I don't know.")
    if (/what word did I ask you/i.test(text)) return say(current, recall(current, /Also put the word (\S+?) in your final reply/) ?? "I don't know.")
    if (/what codename did I give/i.test(text)) return say(current, recall(current, /My codename for this project is (\S+?);/) ?? "I don't know.")
    return say(current, "OK")
  }

  /** The last thing the person asked that `pattern` finds, among the session's own messages. */
  function recall(current, pattern) {
    const asked = saved(current.id).filter((update) => update.sessionUpdate === "user_message_chunk").map((update) => pattern.exec(update.content.text)?.[1])
    return asked.filter(Boolean).at(-1)
  }

  const steered = (text) => /Also put the word (\S+?) in your final reply/.exec(text)?.[1] ?? ""

  /** A foreground `sleep`, as a terminal tool; false when Stop ended it. */
  async function terminal(current, seconds) {
    const toolCallId = randomUUID()
    const command = `sleep ${seconds}`
    await send(current, { sessionUpdate: "tool_call", toolCallId, title: command, kind: "execute", status: "in_progress", rawInput: { command } })
    const child = spawn("sleep", [String(seconds)], { stdio: "ignore" })
    const ended = await new Promise((resolve) => {
      child.once("exit", () => resolve(true))
      current.running.cancel = () => { child.kill(); resolve(false) }
    })
    await send(current, { sessionUpdate: "tool_call_update", toolCallId, status: ended ? "completed" : "failed" })
    return ended
  }

  /** Plan mode: propose, ask to build, and build what was approved. */
  async function plan(current, text) {
    const asked = /named (\S+) in the current folder containing exactly (\S+?)\./.exec(text)
    if (!asked) return say(current, "What should the plan do?")
    const [, name, content] = asked
    const toolCallId = randomUUID()
    const proposal = `${PLAN_STEP} ${content} to ${name}.`
    await send(current, { sessionUpdate: "tool_call", toolCallId, title: "write_plan", kind: "think", status: "completed", rawInput: { plan: proposal } })
    const chosen = await client.requestPermission({
      sessionId: current.id,
      toolCall: { toolCallId, title: "Build the plan?", kind: "switch_mode", rawInput: { plan: proposal } },
      options: [{ optionId: "build", name: "Build it", kind: "allow_once" }, { optionId: "keep-planning", name: "Keep planning", kind: "reject_once" }],
    })
    if (chosen.outcome.outcome !== "selected" || chosen.outcome.optionId !== "build") return say(current, "Kept planning.")
    current.mode = "full"
    await send(current, { sessionUpdate: "current_mode_update", currentModeId: "full" })
    return build(current)
  }

  /** Builds the session's last plan, as a model reading its history would. */
  function build(current) {
    const proposals = saved(current.id).filter((update) => update.sessionUpdate === "tool_call" && update.title === "write_plan")
    const step = new RegExp(`${PLAN_STEP} (\\S+) to (\\S+)\\.`).exec(proposals.at(-1)?.rawInput.plan ?? "")
    if (!step) return say(current, "There is no plan to build.")
    writeFileSync(join(current.cwd, step[2]), step[1])
    return say(current, `Built ${step[2]}.`)
  }

  return {
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        agentInfo: { name: "stand-in", version: "1.0.0" },
      }
    },
    async authenticate() {
      return {}
    },
    async newSession({ cwd }) {
      const id = randomUUID()
      open(id)
      writeFileSync(file(id), "")
      sessions.set(id, { id, cwd, mode: MODES.currentModeId })
      return { sessionId: id, modes: MODES, configOptions: OPTIONS }
    },
    async loadSession({ sessionId, cwd }) {
      if (!existsSync(file(sessionId))) throw RequestError.resourceNotFound(sessionId)
      open(sessionId)
      const current = { id: sessionId, cwd, mode: MODES.currentModeId }
      sessions.set(sessionId, current)
      for (const update of saved(sessionId)) await client.sessionUpdate({ sessionId, update })
      return { modes: { ...MODES, currentModeId: current.mode }, configOptions: OPTIONS }
    },
    async setSessionMode({ sessionId, modeId }) {
      if (!MODES.availableModes.some((mode) => mode.id === modeId)) throw RequestError.invalidParams({ modeId })
      session(sessionId).mode = modeId
      return {}
    },
    async prompt({ sessionId, prompt }) {
      const current = session(sessionId)
      // A message sent while a turn runs joins it, and is answered when it ends.
      if (current.running) {
        const text = prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n")
        keep(current, { sessionUpdate: "user_message_chunk", content: { type: "text", text } })
        current.running.steers.push(text)
        return { stopReason: await current.running.ended }
      }
      let end
      current.running = { steers: [], ended: new Promise((resolve) => { end = resolve }) }
      await client.sessionUpdate({ sessionId, update: { sessionUpdate: "config_option_update", configOptions: OPTIONS } })
      const stopReason = (await turn(current, prompt)) === "cancelled" ? "cancelled" : "end_turn"
      current.running = undefined
      end(stopReason)
      return { stopReason }
    },
    async cancel({ sessionId }) {
      sessions.get(sessionId)?.running?.cancel?.()
    },
  }
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
