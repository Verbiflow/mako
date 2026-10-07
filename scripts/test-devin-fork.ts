// Devin's native fork against its real CLI, on recorded pairs' stores in
// sandboxes, while another Devin process holds the source session as the
// conversation's own does. Sends no prompt, so it spends no usage; the
// account's credentials are linked, never copied. Skips without Devin.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, rm, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { acpClientCapabilities } from "../electron/providers/acp-source.js"
import { devinAcpSource } from "../electron/providers/devin/acp.js"
import { devinExecutable } from "../electron/providers/devin/executable.js"
import { devinCheckpoint, devinFork } from "../electron/providers/devin/fork.js"
import { environmentForExecutable } from "../electron/executable.js"
import { rpcPeer, sandboxed, stop } from "./harness-sandbox.js"

const executable = devinExecutable()
const signedIn = join(homedir(), ".local/share/devin/credentials.toml")
if (!executable || !existsSync(signedIn)) {
  console.log(`devin fork: Devin is ${executable ? "not signed in" : "not installed"}; skipped`)
  process.exit(0)
}

const PAIRS = "scripts/fixtures/native-decoding/devin/pairs"
const CWD = "/tmp/mako-pair/project"
const capabilities = acpClientCapabilities(devinAcpSource)
const Steps = z.object({ steps: z.array(z.object({ userMessageId: z.string() })) })
const timings: string[] = []

async function withPair(pair: string, work: (pair: {
  env: NodeJS.ProcessEnv
  args: readonly string[]
  /** A Devin process with revert advertised, as Devin.app's is. */
  agent(): Promise<{ load(id: string): Promise<void>; steps(id: string): Promise<string[]>; close(): Promise<void> }>
  fork(nativeId: string, checkpoint: string, signal?: AbortSignal): Promise<string>
}) => Promise<void>): Promise<void> {
  await sandboxed("devin-fork", "devin", async (sandbox) => {
    await cp(join(PAIRS, pair, "home"), sandbox.home, { recursive: true })
    const credentials = join(sandbox.home, ".local/share/devin/credentials.toml")
    await rm(credentials, { force: true })
    await symlink(signedIn, credentials)
    await mkdir(CWD, { recursive: true })
    const launch = await devinAcpSource.launch({ appPath: process.cwd(), execPath: process.execPath, cwd: CWD, env: sandbox.env })
    assert.ok(launch && executable)
    const env = environmentForExecutable(executable, sandbox.env)
    launch.configureEnvironment(env)
    await work({
      env,
      args: launch.args,
      async agent() {
        const child = spawn(executable, launch.args, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] })
        const peer = rpcPeer(child, { jsonrpc: true, timeoutMs: 30_000, refusal: "test", received: () => undefined })
        // SAFETY: ACP's capability types are JSON; the peer's parameter type cannot see that through their optional fields.
        await peer.call("initialize", { protocolVersion: 1, clientCapabilities: { ...capabilities, _meta: { ...capabilities._meta, "cognition.ai/revert": true } } } as never)
        return {
          load: async (sessionId) => {
            await peer.call("session/load", { sessionId, cwd: CWD, mcpServers: [] })
          },
          steps: async (sessionId) =>
            Steps.parse(await peer.call("_cognition.ai/revert/listSteps", { sessionId })).steps.map((step) => step.userMessageId),
          close: async () => {
            peer.close()
            await stop(child)
          },
        }
      },
      async fork(nativeId, checkpoint, signal = new AbortController().signal) {
        const started = performance.now()
        const id = await devinFork({ nativeId, checkpoint, executable, args: launch.args, env, cwd: CWD, clientCapabilities: capabilities, owner: "test-devin-fork", signal })
        timings.push(`${Math.round(performance.now() - started)} ms`)
        return id
      },
    })
  })
}

await withPair("rewound-turn", async ({ env, agent, fork }) => {
  const SOURCE = "longhaired-secretary"
  const turns = ["c165ec98-d681-47db-a68e-ebaf7420b3a3", "86191e75-13d6-412a-9f20-540f1ab18639"]
  assert.equal(devinCheckpoint({ nativeId: SOURCE, env }), "32", "the saved head, where the last turn ended")
  assert.equal(devinCheckpoint({ nativeId: "no-such-session", env }), undefined)
  const holder = await agent()
  try {
    await holder.load(SOURCE)
    assert.deepEqual(await holder.steps(SOURCE), turns)
    const early = await fork(SOURCE, "26")
    const late = await fork(SOURCE, "32")
    const reader = await agent()
    try {
      await reader.load(early)
      assert.deepEqual(await reader.steps(early), turns.slice(0, 1), "a fork at the first turn's checkpoint ends with it")
      await reader.load(late)
      assert.deepEqual(await reader.steps(late), turns, "a fork at the last turn's checkpoint keeps every turn")
    } finally {
      await reader.close()
    }
    assert.deepEqual(await holder.steps(SOURCE), turns, "the source session is untouched")
    await assert.rejects(fork(SOURCE, "head"), /Devin could not fork the session: "head" is not one of its nodes/)
    await assert.rejects(fork("no-such-session", "26"), /Devin could not fork the session: /)
    await assert.rejects(fork(SOURCE, "26", AbortSignal.abort()), /Devin could not fork the session: the conversation closed/)
  } finally {
    await holder.close()
  }
})

// A steer is a step of its own in Devin's list; the turn's checkpoint, read as it ends, is past it.
await withPair("steered-shell", async ({ env, agent, fork }) => {
  const SOURCE = "adorable-waitress"
  const checkpoint = devinCheckpoint({ nativeId: SOURCE, env })
  assert.equal(checkpoint, "30")
  const reader = await agent()
  try {
    await reader.load(SOURCE)
    const steps = await reader.steps(SOURCE)
    assert.equal(steps.length, 2, "the prompt and its steer")
    const copy = await fork(SOURCE, checkpoint)
    await reader.load(copy)
    assert.deepEqual(await reader.steps(copy), steps, "the fork keeps the message sent into the turn")
  } finally {
    await reader.close()
  }
})

console.log(`devin fork: ${timings.slice(0, 2).join(", ")} with the source held by another process, ${timings.at(-1)} after a steered turn`)
