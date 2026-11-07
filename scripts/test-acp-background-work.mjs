import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { noAcpCapabilities } from "./fixtures/driver-capabilities.ts"
import { admitted } from "./fixtures/admitted-start.ts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { testScratch } from "./lib/test-scratch.mjs"
import { ranOut } from "./lib/ran-out.ts"

const nativeStores = new NativeStores(false)

if (!process.versions.electron) {
  const root = testScratch("mako-acp-background-test-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-acp-background-test", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_ACP_BACKGROUND_ROOT: root, MAKO_REPO: resolve(".") }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  const deadline = setTimeout(() => child.kill("SIGTERM"), 60_000)
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
  const root = process.env.MAKO_ACP_BACKGROUND_ROOT
  const repo = process.env.MAKO_REPO
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { createHarnessHost, detachedHarnessContext } = await import(join(repo, "packages/host/dist/harnesses/harness-host.js"))
  const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))
  const { createGrokAcpSource } = await import(join(repo, "packages/host/dist/harnesses/grok/acp.js"))
  const { createDevinAcpSource } = await import(join(repo, "packages/host/dist/harnesses/devin/acp.js"))
  const { createAcpEngine } = await import(join(repo, "packages/host/dist/harnesses/acp.js"))
  const observers = { grok: createGrokAcpSource().observeBackground, devin: createDevinAcpSource(nativeStores).observeBackground }
  const running = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function open(agent) {
    const provider = `background-${agent}-${randomUUID()}`
    const acp = createAcpEngine({
      ...noAcpCapabilities,
      provider,
      available: () => true,
      observeBackground: observers[agent],
      launch: async () => ({
        command: process.execPath,
        args: [join(repo, "scripts/fixtures/acp-background-agent.mjs")],
        configureEnvironment(env) {
          env.ELECTRON_RUN_AS_NODE = "1"
          env.ACP_BACKGROUND_FIXTURE = agent
        },
      }),
    }, { processes: providerHost.discovery, servesMcp: () => false, appRoot: repo, approvalRoot: join(root, "approval-evidence") })
    const id = randomUUID()
    const events = []
    await acp.start(root, admitted(provider, {
      conversationId: id,
      emit: (event) => events.push(event),
      mcpSnapshot: async () => ({ cwd: root, generatedAt: Date.now(), servers: [], providers: [] }),
    }))
    const session = () => events.findLast((event) => event.type === "live-session")?.session
    const texts = () => events.flatMap((event) => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
      .filter((update) => update.kind === "text").map((update) => update.text)
    const until = async (label, predicate) => {
      for (let waited = 0; !predicate(); waited += 10) {
        if (waited > 30_000) throw new Error(`${agent}: timed out waiting for ${label}; status ${session()?.status}`)
        await delay(10)
      }
    }
    const prompt = (text) => acp.prompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    await prompt("start")
    await until("the background command", () => texts().some((text) => text.startsWith("background ")))
    const background = Number(texts().find((text) => text.startsWith("background ")).split(" ")[1])
    await until("the prompt to end", () => session()?.status === "ready")
    assert.ok(running(background), `${agent}: the background command runs`)
    return { id, acp, background, session, texts, until, prompt }
  }

  async function close(agent) {
    const { id, acp, background } = await open(agent)
    const started = Date.now()
    const { waits } = await ranOut(() => acp.close(id))
    const elapsed = Date.now() - started
    await delay(100)
    const survived = running(background)
    if (survived) process.kill(background)
    return { survived, elapsed, waits }
  }

  const grok = await close("grok")
  assert.equal(grok.survived, false, "session/close reaches an agent that advertises it")
  // What each close waited for, rather than the runner's clock: the 5 s grace is what a close that didn't reach the agent would wait out.
  assert.ok(grok.waits.every((ms) => ms < 5_000), `Grok closed without waiting out the grace (${grok.elapsed} ms; ran out: ${grok.waits.join(", ")})`)
  console.log("PASS: Closing a conversation sends session/close, which ends the background work Grok started")

  const devin = await close("devin")
  assert.equal(devin.survived, false, "closing stdin reaches an agent without session/close")
  assert.ok(devin.waits.every((ms) => ms < 5_000), `Devin closed without waiting out the grace (${devin.elapsed} ms; ran out: ${devin.waits.join(", ")})`)
  console.log("PASS: Closing a conversation closes stdin, which ends the background work Devin started")

  const stuck = await close("stuck")
  assert.ok(stuck.elapsed >= 4_900, `a stuck agent is terminated after the grace, not ${stuck.elapsed} ms`)
  assert.deepEqual(stuck.waits.filter((ms) => ms >= 5_000), [5_000], "the grace ran out, and no later wait did")
  console.log("PASS: An agent that does not exit after its stdin closes is terminated once the grace ends")

  for (const agent of ["grok", "devin"]) {
    const conversation = await open(agent)
    await conversation.until("the running count", () => conversation.session()?.backgroundTasks === 1)
    void conversation.prompt("work")
    await conversation.until("the second turn", () => conversation.session()?.status === "running")
    await conversation.acp.cancel(conversation.id)
    await conversation.until("the stopped turn", () => conversation.session()?.status === "ready")
    await conversation.until("the background command to end", () => !running(conversation.background))
    await conversation.until("the running count to clear", () => conversation.session()?.backgroundTasks === 0)
    assert.equal(conversation.session()?.lastStop, "cancelled")
    await conversation.prompt("after")
    await conversation.until("the next answer", () => conversation.texts().includes("answered after"))
    await conversation.acp.close(conversation.id)
  }
  console.log("PASS: Stop ends the turn and the background work on Grok (close and resume) and Devin (killBackgroundShell); the session answers afterwards")

  for (const agent of ["grok", "devin"]) {
    const conversation = await open(agent)
    await conversation.until("the running count", () => conversation.session()?.backgroundTasks === 1)
    await conversation.acp.cancel(conversation.id)
    await conversation.until("the background command to end", () => !running(conversation.background))
    await conversation.until("the running count to clear", () => conversation.session()?.backgroundTasks === 0)
    await conversation.prompt("after")
    await conversation.until("the next answer", () => conversation.texts().includes("answered after"))
    await conversation.acp.close(conversation.id)
  }
  console.log("PASS: Stop with no turn running ends the background work on Grok and Devin; the session answers afterwards")
}
