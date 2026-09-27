import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-codex-background-test-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-codex-background-test", main: fileURLToPath(import.meta.url) }))
  const executable = join(root, "codex")
  await writeFile(executable, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${resolve("scripts/fixtures/codex-background-app-server.mjs")}" "$@"\n`)
  await chmod(executable, 0o755)
  const env = { ...process.env, MAKO_CODEX_BACKGROUND_ROOT: root, MAKO_REPO: resolve("."), CODEX_EXECUTABLE: executable }
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
  const root = process.env.MAKO_CODEX_BACKGROUND_ROOT
  const repo = process.env.MAKO_REPO
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { bindCodexApp, codexAppStart, codexAppPrompt, codexAppCancel, codexAppClose } = await import(join(repo, "dist-electron/codex-app.js"))
  const events = []
  bindCodexApp((event) => events.push(event))
  const running = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const leftovers = []

  async function open() {
    const id = randomUUID()
    await codexAppStart(root, {
      conversationId: id,
      mcpSnapshot: async () => ({ cwd: root, generatedAt: Date.now(), servers: [], providers: [] }),
    })
    const session = () => events.findLast((event) => event.type === "live-session" && event.session.id === id)?.session
    const texts = () => events.flatMap((event) => event.id !== id ? [] : event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
      .filter((update) => update.kind === "text").map((update) => update.text)
    const until = async (label, predicate) => {
      for (let waited = 0; !predicate(); waited += 10) {
        if (waited > 5000) throw new Error(`timed out waiting for ${label}; status ${session()?.status}`)
        await delay(10)
      }
    }
    const pid = (prefix) => Number(texts().find((text) => text.startsWith(prefix))?.split(" ")[1])
    const prompt = (text) => codexAppPrompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    await prompt("start")
    await until("the background command", () => pid("background ") > 0)
    await until("the running count", () => session()?.status === "ready" && session()?.backgroundTasks === 1)
    const background = pid("background ")
    leftovers.push(background)
    assert.ok(running(background), "the background command runs")
    return { id, background, session, texts, until, pid, prompt }
  }

  try {
    const conversation = await open()
    void conversation.prompt("work")
    await conversation.until("the foreground command", () => conversation.pid("foreground ") > 0 && conversation.session()?.status === "running")
    const foreground = conversation.pid("foreground ")
    leftovers.push(foreground)
    await codexAppCancel(conversation.id)
    await conversation.until("the stopped turn", () => conversation.session()?.status === "ready")
    assert.equal(conversation.session()?.lastStop, "interrupted")
    await conversation.until("the background command to end", () => !running(conversation.background))
    await conversation.until("the interrupted command to end", () => !running(foreground))
    await conversation.until("the running count to clear", () => conversation.session()?.backgroundTasks === 0)
    await conversation.prompt("after")
    await conversation.until("the next answer", () => conversation.texts().includes("answered after"))
    await codexAppClose(conversation.id)
    console.log("PASS: Stop ends the turn, the terminals the thread left running, and the command the interrupt turned into one; the thread answers afterwards")

    const idle = await open()
    await codexAppCancel(idle.id)
    await idle.until("the background command to end", () => !running(idle.background))
    await idle.until("the running count to clear", () => idle.session()?.backgroundTasks === 0)
    await codexAppClose(idle.id)
    console.log("PASS: Stop with no turn running ends the terminals the thread left running")

    const closing = await open()
    await codexAppClose(closing.id)
    await delay(100)
    assert.equal(running(closing.background), false, "closing ends the terminals before the app-server exits")
    console.log("PASS: Closing a conversation ends the terminals its thread left running")
  } finally {
    for (const pid of leftovers) if (running(pid)) process.kill(pid)
  }
}
