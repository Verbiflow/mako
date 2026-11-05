// Grok's and Devin's native forks run each request to their own process under
// the startup watch, so a fork that fails says which request it failed in.
// A stand-in agent answers `initialize` (or doesn't) and dies at a chosen
// request; no timer decides anything.
import assert from "node:assert/strict"
import { ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { devinFork } from "@mako/host/harnesses/devin/fork"
import { grokFork } from "@mako/host/harnesses/grok/fork"
import { ProviderProcessOutlivedError } from "@mako/host/harnesses/provider-process"

const AGENT = String.raw`
const dieAt = process.env.DIE_AT
if (dieAt === "stay") {
  // Forks, then ignores its input closing; only a signal ends it.
  setInterval(() => {}, 1000)
  process.stdin.on("end", () => {})
  require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid))
}
if (dieAt === "refuse") {
  // Refuses the handshake, then ignores its input closing and SIGTERM: only SIGKILL ends it.
  process.on("SIGTERM", () => {})
  setInterval(() => {}, 1000)
  require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid))
}
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (let at; (at = buffer.indexOf("\n")) >= 0;) {
    const message = JSON.parse(buffer.slice(0, at))
    buffer = buffer.slice(at + 1)
    if (dieAt === "stay" && message.method !== "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { newSessionId: "copy", forkedSessionId: "copy" } }) + "\n")
      continue
    }
    if (message.method === dieAt || (dieAt === "fork" && message.method !== "initialize")) {
      process.stderr.write("the store is locked\n")
      process.exit(3)
    }
    if (message.method === "initialize" && dieAt === "refuse")
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "refused" } }) + "\n")
    else if (message.method === "initialize")
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {}, authMethods: [] } }) + "\n")
  }
})
`

/** Whether the process is there; only probes it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Resolves once the process is gone, checking again until it is. */
async function gone(pid: number): Promise<void> {
  while (alive(pid)) await new Promise((resolve) => setTimeout(resolve, 50))
}

const root = mkdtempSync(join(tmpdir(), "mako-fork-watches-"))
try {
  const agent = join(root, "agent.cjs")
  writeFileSync(agent, AGENT)
  const cwd = join(root, "project")
  mkdirSync(cwd)
  const grokHome = join(root, "grok")
  const nativeId = "session-1"
  mkdirSync(join(grokHome, "sessions", encodeURIComponent(cwd), nativeId), { recursive: true })
  writeFileSync(join(grokHome, "sessions", encodeURIComponent(cwd), nativeId, "updates.jsonl"), "")

  const pidFile = join(root, "agent.pid")
  const input = (dieAt: string, checkpoint: string) => ({
    nativeId,
    checkpoint,
    executable: process.execPath,
    args: [agent],
    env: { ...process.env, NODE_OPTIONS: "", DIE_AT: dieAt, GROK_HOME: grokHome, PID_FILE: pidFile },
    cwd,
    clientCapabilities: {},
    owner: "test-fork-watches",
    signal: new AbortController().signal,
  })

  for (const [name, fork, checkpoint] of [["Grok", grokFork, "2"], ["Devin", devinFork, "4"]] as const) {
    await assert.rejects(fork(input("fork", checkpoint)), new RegExp(`^Error: ${name} could not fork the session during session fork: `), `${name}: the request the fork died in is named`)
    await assert.rejects(fork(input("initialize", checkpoint)), new RegExp(`^Error: ${name} could not fork the session during initialize: `), `${name}: so is a death at the handshake`)
    const closed = new AbortController()
    closed.abort()
    await assert.rejects(fork({ ...input("fork", checkpoint), signal: closed.signal }), new RegExp(`^Error: ${name} could not fork the session: the conversation closed$`))
    // A failed fork reaches its caller without waiting for an agent that won't leave, and that agent is still ended.
    // Its escalation runs on timers, which can't fire before the rejection's continuation: the agent is still there.
    let aliveAtRejection = false
    await assert.rejects(fork(input("refuse", checkpoint)).finally(() => {
      aliveAtRejection = alive(Number(readFileSync(pidFile, "utf8")))
    }), new RegExp(`^Error: ${name} could not fork the session during initialize: refused`), `${name}: a refusal from an agent that won't exit still rejects`)
    assert.ok(aliveAtRejection, `${name}: the rejection reached the caller before the agent's exit`)
    await gone(Number(readFileSync(pidFile, "utf8")))
    // A fork that worked waits for its process, which holds the copy until it's gone: one no signal reaches is a
    // failed fork, not a copy to go on with.
    const signal = ChildProcess.prototype.kill
    ChildProcess.prototype.kill = () => false
    try {
      await assert.rejects(fork(input("stay", checkpoint)), ProviderProcessOutlivedError, `${name}: a fork whose process outlives being ended doesn't succeed`)
    } finally {
      ChildProcess.prototype.kill = signal
    }
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL")
  }
  console.log("fork watches: Grok's and Devin's forks name the request their process died in, a closed conversation says so, a failure never waits on an agent that won't exit, which is still killed, and a fork whose process outlives that fails")
} finally {
  rmSync(root, { recursive: true, force: true })
}
