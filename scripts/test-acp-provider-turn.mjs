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
  const { devinAcpSource } = await import(join(repo, "dist-electron/providers/devin/acp.js"))
  const { liveStart, livePrompt, liveCancel, liveClose } = await import(join(repo, "dist-electron/acp.js"))
  const fixture = (provider, source) => providerHost.acpSources.register({
    provider,
    canResume: false,
    available: () => true,
    providerTurns: source.providerTurns,
    observeAgents: source.observeAgents,
    clientCapabilities: source.clientCapabilities,
    launch: async () => ({
      command: process.execPath,
      args: [join(repo, "scripts/fixtures/acp-provider-turn-agent.mjs")],
      configureEnvironment(env) { env.ELECTRON_RUN_AS_NODE = "1" },
    }),
  })
  fixture("provider-turn-grok", grokAcpSource)
  fixture("provider-turn-devin", devinAcpSource)

  async function conversation(provider) {
    const id = randomUUID()
    const events = []
    await liveStart(provider, root, {
      conversationId: id,
      emit: (event) => events.push(event),
      mcpSnapshot: async () => ({ cwd: root, generatedAt: Date.now(), servers: [], providers: [] }),
    })
    const session = () => events.findLast((event) => event.type === "live-session")?.session
    const updates = () => events.flatMap((event) =>
      event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
    const until = async (label, predicate) => {
      for (let waited = 0; !predicate(); waited += 10) {
        if (waited > 5000) throw new Error(`Timed out waiting for ${label}; last status ${session()?.status}`)
        await delay(10)
      }
    }
    return {
      events, session, updates, until,
      opened: () => updates().filter((update) => update.kind === "provider-turn"),
      statusesSince: (seen) => events.slice(seen).flatMap((event) => event.type === "live-session" ? [event.session.status] : []),
      async prompt(text) {
        await livePrompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
        await until(`${text} to end`, () => session()?.status === "ready")
      },
      cancel: () => liveCancel(id),
      close: () => liveClose(id),
    }
  }

  const grok = await conversation("provider-turn-grok")
  await grok.prompt("self-started")
  const seen = grok.events.length
  await grok.until("the self-started turn", () => grok.opened().length === 1)
  await grok.until("the self-started turn to end", () => grok.session()?.status === "ready")
  assert.deepEqual(grok.opened(), [{ kind: "provider-turn", reason: 'Background command "Sleep briefly then print BG-DONE" completed (exit code 0)' }])
  assert.ok(grok.statusesSince(seen).includes("running"), "the turn Grok started itself shows as running")
  assert.equal(grok.session()?.lastStop, "completed")
  const turn = grok.updates().findIndex((update) => update.kind === "provider-turn")
  assert.ok(grok.updates().slice(turn).some((update) => update.kind === "text" && update.text.includes("BG-DONE")),
    "the reply belongs to the turn it opened")
  console.log("PASS: A turn Grok starts after a background command opens with its cause, runs, and ends on turn_completed")

  await grok.prompt("cancelled")
  await grok.until("the cancellable turn", () => grok.opened().length === 2 && grok.session()?.status === "running")
  await grok.cancel()
  await grok.until("the cancelled turn to end", () => grok.session()?.status === "ready")
  await delay(150)
  assert.equal(grok.opened().length, 2, "the thought chunk trailing a cancel opens no turn")
  assert.equal(grok.session()?.status, "ready")
  assert.equal(grok.session()?.lastStop, "interrupted")
  console.log("PASS: Stop ends a turn Grok started itself, and the chunk trailing the cancel stays with it")

  await grok.prompt("unannounced")
  await delay(150)
  assert.equal(grok.opened().length, 2, "output without an announced turn opens nothing")
  assert.equal(grok.session()?.status, "ready")
  console.log("PASS: Output Grok did not announce as a new turn opens nothing")
  await grok.close()

  const devin = await conversation("provider-turn-devin")
  await devin.prompt("devin-self-started")
  const devinSeen = devin.events.length
  await devin.until("the turn Devin starts on the finished subagent", () => devin.opened().length === 1)
  await devin.until("that turn to end", () => devin.session()?.status === "ready")
  assert.deepEqual(devin.opened(), [{ kind: "provider-turn", reason: 'Subagent "Run the checks" completed' }])
  assert.ok(devin.statusesSince(devinSeen).includes("running"), "the turn Devin started itself shows as running")
  assert.equal(devin.session()?.lastStop, "completed")
  const opener = devin.updates().findIndex((update) => update.kind === "provider-turn")
  const texts = (from, to) => devin.updates().slice(from, to).filter((update) => update.kind === "text").map((update) => update.text).join("")
  assert.ok(texts(opener).includes("The checks passed."), "the reply belongs to the turn it opened")
  assert.ok(!texts(0).includes("All checks passed."), "the subagent's own text stays out of the parent's turns")
  console.log("PASS: A turn Devin starts after a background subagent opens with its cause, runs, and ends on agent_stopped")

  await devin.prompt("devin-self-cancelled")
  await devin.until("the cancellable turn", () => devin.opened().length === 2 && devin.session()?.status === "running")
  await devin.cancel()
  await devin.until("the cancelled turn to end", () => devin.session()?.status === "ready")
  assert.equal(devin.session()?.lastStop, "interrupted")
  console.log("PASS: Stop ends a turn Devin started itself")

  await devin.prompt("devin-subagent-stopped")
  await devin.cancel()
  await delay(200)
  assert.equal(devin.opened().length, 2, "a subagent Stop ended opens no turn")
  assert.equal(devin.session()?.status, "ready")
  await devin.prompt("unannounced")
  await delay(150)
  assert.equal(devin.opened().length, 2, "the ended announcement does not open a later turn")
  console.log("PASS: Stopping Devin's background subagent opens no turn, and leaves no announcement behind")
  await devin.close()
}
