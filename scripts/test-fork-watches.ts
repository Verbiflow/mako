// Grok's and Devin's native forks run each request to their own process under
// the startup watch, so a fork that fails says which request it failed in.
// A stand-in agent answers `initialize` (or doesn't) and dies at a chosen
// request; no timer decides anything.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { devinFork } from "@mako/host/harnesses/devin/fork"
import { grokFork } from "@mako/host/harnesses/grok/fork"

const AGENT = String.raw`
const dieAt = process.env.DIE_AT
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (let at; (at = buffer.indexOf("\n")) >= 0;) {
    const message = JSON.parse(buffer.slice(0, at))
    buffer = buffer.slice(at + 1)
    if (message.method === dieAt || (dieAt === "fork" && message.method !== "initialize")) {
      process.stderr.write("the store is locked\n")
      process.exit(3)
    }
    if (message.method === "initialize")
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {}, authMethods: [] } }) + "\n")
  }
})
`

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

  const input = (dieAt: string, checkpoint: string) => ({
    nativeId,
    checkpoint,
    executable: process.execPath,
    args: [agent],
    env: { ...process.env, NODE_OPTIONS: "", DIE_AT: dieAt, GROK_HOME: grokHome },
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
  }
  console.log("fork watches: Grok's and Devin's forks name the request their process died in, and a closed conversation says so")
} finally {
  rmSync(root, { recursive: true, force: true })
}
