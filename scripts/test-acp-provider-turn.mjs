import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-provider-turn-test-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-provider-turn-test", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_PROVIDER_TURN_ROOT: root, MAKO_REPO: resolve(".") }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  const deadline = setTimeout(() => child.kill("SIGTERM"), 30_000)
  const [code] = await once(child, "exit")
  clearTimeout(deadline)
  process.exitCode = code ?? 1
} else {
  const { app } = await import("electron")
  void check().then(() => app.exit(0), (error) => {
    console.error(error)
    app.exit(1)
  })
}

async function check() {
  const { app } = await import("electron")
  const root = process.env.MAKO_PROVIDER_TURN_ROOT
  const repo = process.env.MAKO_REPO
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { providerHost } = await import(join(repo, "dist-electron/providers/index.js"))
  const { grokAcpSource } = await import(join(repo, "dist-electron/providers/grok/acp.js"))
  const { liveStart, livePrompt, liveCancel, liveClose } = await import(join(repo, "dist-electron/acp.js"))
  providerHost.acpSources.register({
    provider: "provider-turn-fixture",
    canResume: false,
    available: () => true,
    providerTurns: grokAcpSource.providerTurns,
    launch: async () => ({
      command: process.execPath,
      args: [join(repo, "scripts/fixtures/acp-provider-turn-agent.mjs")],
      configureEnvironment(env) { env.ELECTRON_RUN_AS_NODE = "1" },
    }),
  })

  const id = randomUUID()
  const events = []
  await liveStart("provider-turn-fixture", root, {
    conversationId: id,
    emit: (event) => events.push(event),
    mcpSnapshot: async () => ({ cwd: root, generatedAt: Date.now(), servers: [], providers: [] }),
  })
  const session = () => events.findLast((event) => event.type === "live-session")?.session
  const updates = () => events.flatMap((event) =>
    event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
  const opened = () => updates().filter((update) => update.kind === "provider-turn")
  const until = async (label, predicate) => {
    for (let waited = 0; !predicate(); waited += 10) {
      if (waited > 5000) throw new Error(`Timed out waiting for ${label}; last status ${session()?.status}`)
      await delay(10)
    }
  }
  const prompt = async (text) => {
    await livePrompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    await until(`${text} to end`, () => session()?.status === "ready")
  }

  await prompt("self-started")
  const statuses = []
  const seen = events.length
  await until("the self-started turn", () => opened().length === 1)
  await until("the self-started turn to end", () => session()?.status === "ready")
  for (const event of events.slice(seen)) if (event.type === "live-session") statuses.push(event.session.status)
  assert.deepEqual(opened(), [{ kind: "provider-turn", reason: 'Background command "Sleep briefly then print BG-DONE" completed (exit code 0)' }])
  assert.ok(statuses.includes("running"), "the turn Grok started itself shows as running")
  assert.equal(session()?.lastStop, "completed")
  const turn = updates().findIndex((update) => update.kind === "provider-turn")
  assert.ok(updates().slice(turn).some((update) => update.kind === "text" && update.text.includes("BG-DONE")),
    "the reply belongs to the turn it opened")
  console.log("PASS: A turn Grok starts after a background command opens with its cause, runs, and ends on turn_completed")

  await prompt("cancelled")
  await until("the cancellable turn", () => opened().length === 2 && session()?.status === "running")
  await liveCancel(id)
  await until("the cancelled turn to end", () => session()?.status === "ready")
  await delay(150)
  assert.equal(opened().length, 2, "the thought chunk trailing a cancel opens no turn")
  assert.equal(session()?.status, "ready")
  assert.equal(session()?.lastStop, "interrupted")
  console.log("PASS: Stop ends a turn Grok started itself, and the chunk trailing the cancel stays with it")

  await prompt("unannounced")
  await delay(150)
  assert.equal(opened().length, 2, "output without an announced turn opens nothing")
  assert.equal(session()?.status, "ready")
  console.log("PASS: Output Grok did not announce as a new turn opens nothing")
  await liveClose(id)
}
