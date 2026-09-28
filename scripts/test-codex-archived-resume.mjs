import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Replying to a thread Codex archived: Codex refuses to resume it until it's
// unarchived, so Mako brings it out of the archive and resumes. Any other
// refusal still fails the reply.
if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-codex-archived-test-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-codex-archived-test", main: fileURLToPath(import.meta.url) }))
    const executable = join(root, "codex")
    await writeFile(executable, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${resolve("scripts/fixtures/codex-archived-app-server.mjs")}" "$@"\n`)
    await chmod(executable, 0o755)
    const env = { ...process.env, MAKO_CODEX_ARCHIVED_ROOT: root, MAKO_REPO: resolve("."), CODEX_EXECUTABLE: executable }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    const deadline = setTimeout(() => child.kill("SIGTERM"), 60_000)
    const [code] = await once(child, "exit")
    clearTimeout(deadline)
    process.exitCode = code ?? 1
  } finally {
    await rm(root, { recursive: true, force: true })
  }
} else {
  const { app } = await import("electron")
  void check().then(() => app.exit(0), (error) => {
    console.error(error)
    app.exit(1)
  })
}

async function check() {
  const { app } = await import("electron")
  const root = process.env.MAKO_CODEX_ARCHIVED_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { bindCodexApp, codexAppStart, codexAppClose } = await import(join(process.env.MAKO_REPO, "dist-electron/codex-app.js"))
  bindCodexApp(() => {})
  const thread = "01a0e752-670b-7900-8d93-804fefadacbd"
  const start = async (name, missing) => {
    const log = join(root, `${name}.log`)
    process.env.MAKO_CODEX_ARCHIVED_LOG = log
    process.env.MAKO_CODEX_ARCHIVED_MISSING = missing ? "1" : "0"
    const id = randomUUID()
    const opened = codexAppStart(root, {
      conversationId: id,
      resume: thread,
      mcpSnapshot: async () => ({ cwd: root, generatedAt: Date.now(), servers: [], providers: [] }),
    })
    const outcome = await opened.then((state) => ({ state }), (error) => ({ error }))
    await codexAppClose(id)
    return { ...outcome, calls: (await readFile(log, "utf8")).trim().split("\n") }
  }

  const archived = await start("archived", false)
  assert.equal(archived.error, undefined, archived.error?.message)
  assert.equal(archived.state.nativeId, thread, "the reply goes on in the same thread")
  assert.deepEqual(archived.calls.filter((call) => call.startsWith("thread/resume") || call === "thread/unarchive"), ["thread/resume", "thread/unarchive", "thread/resume"])

  const missing = await start("missing", true)
  assert.match(missing.error?.message ?? "", /no rollout found/, "another refusal still fails the reply")
  assert.equal(missing.calls.includes("thread/unarchive"), false, "and nothing is unarchived for it")
  console.log("Codex archived resume: a reply to a thread Codex archived unarchives it and resumes the same thread; any other refusal still fails")
}
