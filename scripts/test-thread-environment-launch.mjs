// Every harness's agent process starts with its Thread's values. Each
// installed agent is replaced by a recorder that writes the environment it
// was started with and exits, under a private HOME, so no provider store or
// account is touched.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const NAMES = ["claude", "codex", "grok", "devin", "opencode"]

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-thread-environment-launch-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-thread-environment-launch", main: fileURLToPath(import.meta.url) }))
    const bin = join(root, "bin")
    await mkdir(bin)
    await mkdir(join(root, "home", ".config"), { recursive: true })
    await writeFile(join(root, "recorder.mjs"), `
import { appendFileSync } from "node:fs"
const [name, ...args] = process.argv.slice(2)
const values = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("MAKO_THREAD_")))
appendFileSync(${JSON.stringify(join(root, "launches.jsonl"))}, JSON.stringify({ name, args, values }) + "\\n")
if (args.includes("--version")) { console.log("2.0.0"); process.exit(0) }
setTimeout(() => process.exit(1), 500)
`)
    for (const name of NAMES) {
      const path = join(bin, name)
      await writeFile(path, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${join(root, "recorder.mjs")}" ${name} "$@"\n`)
      await chmod(path, 0o755)
    }
    const env = {
      ...process.env,
      HOME: join(root, "home"),
      PATH: `${bin}:/usr/bin:/bin`,
      CLAUDE_CODE_EXECUTABLE: join(bin, "claude"),
      CODEX_EXECUTABLE: join(bin, "codex"),
      OPENCODE_BIN_PATH: join(bin, "opencode"),
      MAKO_THREAD_ID: "inherited-from-the-parent",
      MAKO_LAUNCH_ROOT: root,
      MAKO_REPO: resolve("."),
    }
    delete env.ELECTRON_RUN_AS_NODE
    const { default: electron } = await import("electron")
    const child = spawn(electron, [root], { stdio: "inherit", env })
    const deadline = setTimeout(() => child.kill("SIGTERM"), 120_000)
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
  const root = process.env.MAKO_LAUNCH_ROOT
  const repo = process.env.MAKO_REPO
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { providerHost } = await import(join(repo, "dist-electron/providers/index.js"))
  const { createCursorSdkDriver } = await import(join(repo, "dist-electron/providers/cursor/sdk/driver.js"))
  const cwd = join(root, "work")
  await mkdir(cwd)
  const environment = { thread: randomUUID(), host: "fix-login.thread.localhost", port: 20_110, ports: 10, dataDir: join(root, "thread-data") }
  const expected = {
    MAKO_THREAD_ID: environment.thread,
    MAKO_THREAD_HOST: environment.host,
    MAKO_THREAD_PORT: "20110",
    MAKO_THREAD_PORTS: "10",
    MAKO_THREAD_URL: "http://fix-login.thread.localhost:20110",
    MAKO_THREAD_DATA_DIR: environment.dataDir,
  }
  const options = () => ({
    conversationId: randomUUID(),
    emit: () => {},
    mcpSnapshot: async () => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
    threadEnvironment: environment,
  })
  const outcomes = {}
  for (const name of NAMES) {
    const driver = providerHost.liveDrivers.get(name)
    assert.ok(driver, `${name} has a live driver`)
    const id = options()
    const started = await Promise.race([
      driver.start(cwd, id).then(() => "started", (error) => `failed: ${error instanceof Error ? error.message : String(error)}`),
      new Promise((done) => setTimeout(() => done("still starting"), 15_000)),
    ])
    outcomes[name] = started
    await Promise.resolve(driver.close(id.conversationId)).catch(() => undefined)
  }

  const bare = { ...options(), threadEnvironment: undefined }
  const codex = providerHost.liveDrivers.get("codex")
  await codex.start(cwd, bare).catch(() => undefined)
  await Promise.resolve(codex.close(bare.conversationId)).catch(() => undefined)

  let cursorEnv
  const cursor = createCursorSdkDriver({
    auth: { childEnv: async () => ({ ...process.env }), reportRejected() {}, status: async () => ({}), signInWithBrowser: async () => ({}) },
    stateRoot: () => join(root, "cursor"),
    home: join(root, "home"),
    client: (spawnOptions) => {
      cursorEnv = spawnOptions.env
      throw new Error("recorded")
    },
  })
  await cursor.start(cwd, options()).catch(() => undefined)

  const launches = (await readFile(join(root, "launches.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  const report = {}
  for (const name of NAMES) {
    const own = launches.filter((launch) => launch.name === name)
    const agent = own.find((launch) => !launch.args.includes("--version"))
    report[name] = { start: outcomes[name], invocations: own.map((launch) => launch.args.slice(0, 3).join(" ") || "(no arguments)") }
    assert.ok(agent, `${name}'s agent process was started (${outcomes[name]})`)
    assert.deepEqual(agent.values, expected, `${name}'s agent process started with exactly its Thread's values`)
  }
  const unplaced = launches.filter((launch) => launch.name === "codex" && !launch.args.includes("--version")).at(-1)
  assert.notEqual(unplaced, launches.find((launch) => launch.name === "codex"), "the agent without a Thread was started too")
  assert.deepEqual(unplaced.values, {}, "an agent without a Thread never inherits the values of the Mako that started it")
  assert.ok(cursorEnv, "the Cursor child was prepared")
  assert.deepEqual(Object.fromEntries(Object.entries(cursorEnv).filter(([key]) => key.startsWith("MAKO_THREAD_"))), expected, "the Cursor child starts with exactly its Thread's values")
  report.cursor = { start: "child options recorded before spawn" }
  console.log(JSON.stringify(report, null, 2))
  console.log("thread environment launch: all six harnesses start their agent with the Thread's values, and an inherited value never leaks")
}
