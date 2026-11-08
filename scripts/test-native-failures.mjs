import assert from "node:assert/strict"
import { ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { appendFileSync } from "node:fs"
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { admitted } from "./fixtures/admitted-start.ts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { testScratch } from "./lib/test-scratch.mjs"

const nativeStores = new NativeStores(false)

// Failures every harness must survive, through each registered harness's real
// driver against a stand-in native process that speaks its protocol:
// - setup cancellation: Close while startup is pending settles the start and
//   ends the process;
// - a prompt handed over to a process that dies before acknowledging it, while
//   a child it started still holds its pipes: the driver reports the exit
//   promptly as one failed-and-disconnected update, and never claims delivery;
// - the runtime version the process reports is recorded, so a wake under a
//   different version is assessed rather than trusted;
// - a close that can't end the process rejects and keeps the session, so its
//   binding's place isn't released while it can still write, and the next
//   close ends it.
// A harness registered without a stand-in here fails this test.
if (!process.versions.electron) {
  const root = testScratch("mako-native-failures-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-native-failures", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_FAILURES_ROOT: root, MAKO_REPO: resolve(".") }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  const deadline = setTimeout(() => child.kill("SIGTERM"), 120_000)
  const [code] = await once(child, "exit")
  clearTimeout(deadline)
  await rm(root, { recursive: true, force: true })
  process.exitCode = code ?? 1
} else {
  const { app } = await import("electron")
  void main().then(() => app.exit(0), (error) => {
    console.error(error)
    app.exit(1)
  })
}

const VERSION = "standin-9.9.9"
const HANG_MS = 60_000
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** A hang guard, not a limit: a stand-in is a whole Electron process, and six start at once below. `says` is what the timeout saw. */
async function until(label, check, says = () => "") {
  const deadline = performance.now() + HANG_MS
  for (;;) {
    const value = await check()
    if (value) return value
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}${await says()}`)
    await delay(10)
  }
}
const trace = (line) => process.env.MAKO_FAILURES_TRACE && appendFileSync(process.env.MAKO_FAILURES_TRACE, `${line}\n`)
const settled = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))

async function main() {
  const { app } = await import("electron")
  const root = process.env.MAKO_FAILURES_ROOT
  const repo = process.env.MAKO_REPO
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const load = (path) => import(join(repo, "packages/host/dist/harnesses", path))
  const { createHarnessHost, detachedHarnessContext } = await load("harness-host.js")
  const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))
  const { installHostLog } = await import(join(repo, "packages/host/dist/base/host-log.js"))
  installHostLog(process.env.MAKO_FAILURES_HOST_LOG ?? join(root, "host.log"))
  const fixture = join(repo, "scripts/fixtures/native-failure-agent.mjs")
  const mcpSnapshot = async () => ({ cwd: root, generatedAt: Date.now(), servers: [], providers: [] })

  /** A run's stand-in settings: what it does and where it writes its pids. */
  const scenario = async (provider, behavior) => {
    const dir = join(root, `${provider}-${behavior}-${randomUUID().slice(0, 8)}`)
    await mkdir(dir, { recursive: true })
    const pids = join(dir, "pids.json")
    return { dir, pids, env: { MAKO_STANDIN_BEHAVIOR: behavior, MAKO_STANDIN_PIDS: pids, MAKO_STANDIN_VERSION: VERSION } }
  }

  const { createAcpEngine } = await load("acp.js")
  /**
   * `handshake`: the version its `initialize` says, where it isn't the build's. The source's own launch's `versionArgs`
   * then ask the executable, which is the stand-in behind a script of its own, as Codex's is.
   */
  const acpStandIn = (provider, source, handshake) => {
    let env = {}
    let executable
    const acp = createAcpEngine({
      ...source,
      provider: `failure-${provider}`,
      resume: { kind: "unavailable", reason: "A failure stand-in's sessions are never reopened" },
      available: () => true,
      launch: async (options) => ({
        command: executable ?? process.execPath,
        args: executable ? [] : [fixture],
        ...handshake && { versionArgs: (await source.launch(options)).versionArgs },
        configureEnvironment(target) {
          Object.assign(target, env, { ELECTRON_RUN_AS_NODE: "1", MAKO_STANDIN_PROTOCOL: "acp",
            MAKO_STANDIN_MODES: JSON.stringify((source.nativeModes ?? []).map(({ id, name }) => ({ id, name }))),
            ...handshake && { MAKO_STANDIN_HANDSHAKE_VERSION: handshake } })
        },
      }),
    }, { processes: providerHost.discovery, servesMcp: () => false, appRoot: repo, approvalRoot: join(root, "approval-evidence") })
    return {
      async prepare(settings) {
        env = settings.env
        if (!handshake) return
        executable = join(settings.dir, provider)
        const variables = Object.entries({ ...settings.env, MAKO_STANDIN_PROTOCOL: "acp" }).map(([key, value]) => `${key}='${value}'`).join(" ")
        await writeFile(executable, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ${variables} exec "${process.execPath}" "${fixture}" "$@"\n`)
        await chmod(executable, 0o755)
      },
      start: acp.start,
      prompt: acp.prompt,
      close: acp.close,
      // The version the launch read out of what `--version` printed (`standin-9.9.9`), not the handshake's.
      ...handshake && { runtime: "9.9.9" },
    }
  }
  const { createGrokAcpSource } = await load("grok/acp.js")
  const { createDevinAcpSource } = await load("devin/acp.js")

  const standIns = {
    codex: (() => {
      const driver = providerHost.liveDrivers.get("codex")
      return {
        async prepare(settings) {
          const executable = join(settings.dir, "codex")
          const variables = Object.entries({ ...settings.env, MAKO_STANDIN_PROTOCOL: "codex" }).map(([key, value]) => `${key}='${value}'`).join(" ")
          await writeFile(executable, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ${variables} exec "${process.execPath}" "${fixture}" "$@"\n`)
          await chmod(executable, 0o755)
          process.env.CODEX_EXECUTABLE = executable
        },
        start: (cwd, options) => driver.start(cwd, options),
        prompt: (...args) => driver.prompt(...args),
        close: (id) => driver.close(id),
      }
    })(),
    grok: acpStandIn("grok", createGrokAcpSource()),
    devin: acpStandIn("devin", createDevinAcpSource(nativeStores), "0.0.0-dev"),
    claude: await (async () => {
      const { createClaudeSdkDriver } = await load("claude/sdk-driver.js")
      const { query } = await import(join(repo, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"))
      let executable
      let env = {}
      const driver = createClaudeSdkDriver({
        available: () => true,
        configure: async (cwd) => ({ options: { cwd, pathToClaudeCodeExecutable: executable, env: { ...process.env, ...env } }, account: { name: "default" } }),
        query,
      })
      return {
        async prepare(settings) {
          env = settings.env
          executable = join(settings.dir, "claude")
          const variables = Object.entries({ ...settings.env, MAKO_STANDIN_PROTOCOL: "claude" }).map(([key, value]) => `${key}='${value}'`).join(" ")
          await writeFile(executable, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ${variables} exec "${process.execPath}" "${fixture}" "$@"\n`)
          await chmod(executable, 0o755)
        },
        start: (cwd, options) => driver.start(cwd, options),
        prompt: (...args) => driver.prompt(...args),
        close: (id) => driver.close(id),
      }
    })(),
    opencode: await (async () => {
      const { createOpenCodeDriver } = await load("opencode/live-driver.js")
      const { OpenCodeServers } = await load("opencode/servers.js")
      const driver = createOpenCodeDriver({ stores: nativeStores, servers: new OpenCodeServers(), approvalRoot: async () => join(root, "opencode-approvals") })
      return {
        unproven: {
          exitAfterHandoff: "OpenCode's client decodes every API response with its own schemas, so a stand-in needs its v2 API; scripts/test-opencode-live.ts kills the real server mid-turn",
        },
        async prepare(settings) {
          const executable = join(settings.dir, "opencode")
          const variables = Object.entries({ ...settings.env, MAKO_STANDIN_PROTOCOL: "opencode" }).map(([key, value]) => `${key}='${value}'`).join(" ")
          await writeFile(executable, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ${variables} exec "${process.execPath}" "${fixture}" "$@"\n`)
          await chmod(executable, 0o755)
          process.env.OPENCODE_BIN_PATH = executable
        },
        start: (cwd, options) => driver.start(cwd, options),
        prompt: (...args) => driver.prompt(...args),
        close: (id) => driver.close(id),
      }
    })(),
    cursor: await (async () => {
      const { createCursorSdkDriver } = await load("cursor/sdk/driver.js")
      const { CursorSdkClient } = await load("cursor/sdk/client.js")
      let env = {}
      const signedIn = { state: { status: "signed-in" }, checkedAt: Date.now() }
      const driver = createCursorSdkDriver({
        stores: nativeStores,
        auth: {
          current: signedIn,
          status: async () => signedIn,
          childLaunch: async (base) => ({ env: { ...base }, credential: { kind: "unavailable", reason: "Stand-in" } }),
          reportRejected() {},
        },
        stateRoot: () => join(root, "cursor-state"),
        home: root,
        client: (options) => new CursorSdkClient({ ...options, entry: fixture, env: { ...options.env, ...env, MAKO_STANDIN_PROTOCOL: "cursor" } }),
      })
      return {
        prepare: (settings) => { env = settings.env },
        start: (cwd, options) => driver.start(cwd, options),
        prompt: (...args) => driver.prompt(...args),
        close: (id) => driver.close(id),
      }
    })(),
  }

  const open = async (provider, behavior) => {
    const standIn = standIns[provider]
    const settings = await scenario(provider, behavior)
    await standIn.prepare(settings)
    const id = randomUUID()
    const events = []
    const emit = (event) => events.push({ at: performance.now(), event })
    const started = settled(standIn.start(settings.dir, admitted(provider, { conversationId: id, emit, mcpSnapshot })))
    const opened = performance.now()
    const startState = () => Promise.race([started, delay(0).then(() => undefined)])
    const launching = await until(`${provider} stand-in launched`, async () => {
      const state = await startState()
      if (state && !state.ok) throw new Error(`${provider}: its start failed before its stand-in wrote its pids: ${state.error?.message}`, { cause: state.error })
      // The stand-in's write creates the file, then fills it: a read between the two isn't an answer yet.
      const text = await readFile(settings.pids, "utf8").catch(() => "")
      return text ? text : undefined
    }, async () => {
      const state = await startState()
      const pidsFile = await stat(settings.pids).then(({ size }) => `${size} bytes`, () => "not written")
      return `: start ${state ? "answered, its stand-in never launched" : "still waiting"}, pids file ${pidsFile}, events: ${events.map(({ event }) => event.type).join(", ") || "none"}`
    })
    const pids = JSON.parse(launching)
    trace(`${provider}: launched ${behavior} in ${Math.round(performance.now() - opened)} ms`)
    const sessions = () => events.filter(({ event }) => event.type === "live-session" && event.session.id === id)
    return { provider, id, standIn, events, started, pids, sessions, session: () => sessions().at(-1)?.event.session }
  }

  const missing = []
  const results = []
  for (const driver of providerHost.liveDrivers.list()) {
    const provider = driver.provider
    if (!standIns[provider]) {
      missing.push(provider)
      continue
    }
    const leftovers = []
    trace(`${provider}: checking`)
    try {
      // Setup cancellation.
      const pending = await open(provider, "hang")
      const closedAt = performance.now()
      await pending.standIn.close(pending.id)
      const start = await until(`${provider}: start settles after Close`, () => Promise.race([pending.started, delay(10).then(() => undefined)]))
      assert.equal(start.ok, false, `${provider}: a start cancelled by Close does not report a session`)
      await until(`${provider}: the cancelled process ends`, () => !alive(pending.pids.pid))
      const late = pending.sessions().filter(({ at, event }) => at > closedAt && event.session.status !== "closed" && event.session.connection === "connected")
      assert.deepEqual(late, [], `${provider}: nothing reports a connected session after Close`)

      trace(`${provider}: setup cancel passed`)
      const unproven = standIns[provider].unproven?.exitAfterHandoff
      if (unproven) {
        results.push({ provider, setupCancel: "passed", exitAfterHandoff: "unproven", runtime: "unproven", reason: unproven })
        continue
      }
      // A prompt handed to a process that dies before acknowledging it.
      const run = await open(provider, "exit-on-prompt")
      leftovers.push(run.pids.child, run.pids.grouped)
      const start2 = await run.started
      assert.ok(start2.ok, `${provider}: the stand-in starts: ${start2.error?.message}`)
      trace(`${provider}: started`)
      const evidence = []
      const handedAt = performance.now()
      const prompt = await until(`${provider}: the prompt settles after the process dies`, (() => {
        const result = settled(run.standIn.prompt(run.id, "handed over", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: (e) => evidence.push(e.kind) }))
        return () => Promise.race([result, delay(10).then(() => undefined)])
      })())
      trace(`${provider}: prompt settled ${prompt.ok}`)
      const exit = await until(`${provider}: the exit is reported`, () => run.sessions().find(({ at, event }) => at > handedAt && event.session.connection === "disconnected"))
      assert.equal(exit.event.session.status, "failed", `${provider}: the exit is one failed-and-disconnected update`)
      assert.ok(alive(run.pids.child), `${provider}: the exit was reported while a child still held the pipes`)
      await until(`${provider}: what the dead process left in its group ends with it`, () => !alive(run.pids.grouped))
      assert.ok(!evidence.includes("accepted"), `${provider}: delivery is never claimed for an unacknowledged prompt`)
      // Claude names its version when a turn opens, the others at startup.
      const runtime = exit.event.session.executionContext?.runtime
      assert.deepEqual(runtime && { kind: runtime.kind, version: runtime.version }, { kind: "reported", version: standIns[provider].runtime ?? VERSION }, `${provider}: the reported runtime version is recorded`)
      results.push({ provider, setupCancel: "passed", exitAfterHandoff: prompt.ok ? "resolved" : "rejected", exitReportMs: Math.round(exit.at - handedAt), evidence, runtime: runtime.version })
      trace(`${provider}: closing`)
      await run.standIn.close(run.id)
      trace(`${provider}: closed`)
    } finally {
      for (const pid of leftovers) if (pid && alive(pid)) process.kill(pid, "SIGKILL")
    }
  }
  // A process its signals can't reach: every close waits out its graces, so they run side by side.
  const outliving = await Promise.all(providerHost.liveDrivers.list().map(({ provider }) => open(provider, "stay")))
  const signal = ChildProcess.prototype.kill
  ChildProcess.prototype.kill = () => false
  try {
    await Promise.all(outliving.map(async (run) => {
      const { provider } = run
      // OpenCode's stand-in never gets past starting: Close cancels the start, whose server then holds the binding.
      if (run.standIn.unproven) await run.standIn.close(run.id)
      const start = await run.started
      assert.equal(start.ok, !run.standIn.unproven, `${provider}: the stand-in starts or is cancelled: ${start.error?.message}`)
      const closed = await settled(run.standIn.close(run.id))
      assert.equal(closed.error?.name, "ProviderProcessOutlivedError", `${provider}: a close that couldn't end the process says so`)
      assert.ok(alive(run.pids.pid), `${provider}: the process is really still there`)
    }))
  } finally {
    ChildProcess.prototype.kill = signal
  }
  await Promise.all(outliving.map(async (run) => {
    await run.standIn.close(run.id)
    await until("the next close ends what outlived the last", () => !alive(run.pids.pid))
  }))
  trace("outliving closes passed")
  for (const result of results) console.log(JSON.stringify(result))
  assert.deepEqual(missing, [], `Every registered harness needs a failure stand-in in ${fileURLToPath(import.meta.url)}`)
  const proven = results.filter((result) => result.exitAfterHandoff !== "unproven").map((result) => result.provider)
  console.log(`Native failures: ${results.map((result) => result.provider).join(", ")} cancel during setup; ${proven.join(", ")} report a death after hand-off while a child holds the pipes; a close that can't end a process rejects and the next one ends it, end what it left in its group, and record the runtime version`)
}
