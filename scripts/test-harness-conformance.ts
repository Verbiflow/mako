import "./lib/scratch-git.mjs"
// What every registered harness owes, through ProviderLiveDriver:
// a silent peer fails startup and names the step, a whole-file write goes
// through the publisher, two conversations are charged for their own process
// trees, and, where the CLI is installed, cancel, a heap after a collection,
// and a steer into a running turn behave as docs/harness-conformance.md says.
// Vendor RSS is printed and never fails the run. There is no timing budget;
// a step that never finishes hits the hang guard.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises"
import { appendFileSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { writeHeapSnapshot } from "node:v8"
import { fileURLToPath } from "node:url"
import { topic } from "@mako/host/base/topic"
import { memorySecrets } from "@mako/host/base/secrets"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { STARTUP_SILENCE_MS, withStartupClock, type StartupClock } from "@mako/host/harnesses/provider-startup"
import { createClaudeSdkDriver } from "@mako/host/harnesses/claude/sdk-driver"
import { createCursorSdkDriver } from "@mako/host/harnesses/cursor/sdk/driver"
import { CursorSdkClient } from "@mako/host/harnesses/cursor/sdk/client"
import { CursorSdkAuth } from "@mako/host/harnesses/cursor/sdk/auth"
import { CursorCredentialStore } from "@mako/host/harnesses/cursor/sdk/credentials"
import { FinCostSampler } from "@mako/host/conversations/fin-cost-sampler"
import type { ProcessRow } from "@mako/host/usage/mako-footprint"
import { readProcessTable } from "@mako/host/usage/mako-footprint"
import { readRetainedApprovalDecisions, RetainedApprovalDecisions } from "@mako/host/harnesses/retained-approval-decisions"
import { installClaude } from "@mako/host/harnesses/claude/index"
import { installCodex } from "@mako/host/harnesses/codex/index"
import { installDevin } from "@mako/host/harnesses/devin/index"
import { installGrok } from "@mako/host/harnesses/grok/index"
import { installOpenCode } from "@mako/host/harnesses/opencode/index"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed, type Sandbox } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"
import { scriptedWindsurf } from "./scripted-windsurf.ts"
import { registeredHarnessIds } from "./registered-harnesses.ts"

const FIXTURE = fileURLToPath(new URL("./fixtures/native-failure-agent.mjs", import.meta.url))
const HARNESS_SRC = fileURLToPath(new URL("../packages/host/src/harnesses", import.meta.url))
const HANG = 90_000
const TURNS = 12
/** Prompts a snapshot may still hold. OpenCode keeps a window of the last 11; everyone else keeps the one in hand. */
const OPENCODE_WINDOW = 11
const nativeStores = new NativeStores(false)
const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

interface Spawned { pid: number; owner: string; executable: string }
const spawned: Spawned[] = []
topic<{ spawned: { pid: number; executable: string; owner: string } }>("mako:provider-child").subscribe((event) => {
  if ("spawned" in event) spawned.push({ pid: event.spawned.pid, owner: event.spawned.owner, executable: event.spawned.executable })
})

function collect(): void {
  // SAFETY: `--expose-gc` adds `gc` to the global object; the throw is the miss.
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) throw new Error("Run with node --expose-gc")
  gc()
  gc()
}

function makeClock(): StartupClock & { armed: number; advance(ms: number): void } {
  let at = 0
  const timers: { at: number; run: () => void; off: boolean }[] = []
  const clock = {
    armed: 0,
    silenceMs: STARTUP_SILENCE_MS,
    now: () => at,
    schedule(ms: number, fn: () => void) {
      const timer = { at: at + ms, run: fn, off: false }
      timers.push(timer)
      clock.armed += 1
      return () => { timer.off = true }
    },
    advance(ms: number) {
      at += ms
      for (;;) {
        const due = timers.filter((timer) => !timer.off && timer.at <= at)
        if (!due.length) return
        for (const timer of due) timer.off = true
        for (const timer of due) timer.run()
      }
    },
  }
  return clock
}

async function until(label: string, check: () => boolean | Promise<boolean>, ms = HANG): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`${label} did not finish within ${ms / 1000} s`)
    await delay(25)
  }
}

function reaped(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return true }
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z")
  } catch {
    return true
  }
}

async function shell(path: string, env: NodeJS.ProcessEnv): Promise<void> {
  const variables = Object.entries(env).map(([key, value]) => `${key}='${String(value).replaceAll("'", `'"'"'`)}'`).join(" ")
  await writeFile(path, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ${variables} exec "${process.execPath}" "${FIXTURE}" "$@"\n`)
  await chmod(path, 0o755)
}

/** A peer that speaks the harness's wire and, on `hang`, never answers. */
async function peer(provider: string, behavior: string): Promise<{ dir: string; env: NodeJS.ProcessEnv; pids: string }> {
  const dir = await mkdtemp(join(tmpdir(), `mako-conform-${provider}-`))
  const pids = join(dir, "pids.json")
  const env: NodeJS.ProcessEnv = {
    MAKO_STANDIN_BEHAVIOR: behavior,
    MAKO_STANDIN_PIDS: pids,
    MAKO_STANDIN_VERSION: "9.9.9",
    MAKO_STANDIN_PROTOCOL: provider === "grok" || provider === "devin" ? "acp" : provider,
  }
  return { dir, env, pids }
}

/** The registered driver rebuilds its launch environment from the process environment, so a stand-in path has to be there while it starts. */
async function withProcessEnv(overrides: NodeJS.ProcessEnv, work: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await work()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function registered(provider: string): ProviderLiveDriver {
  const driver = providerHost.liveDrivers.get(provider)
  if (!driver) throw new Error(`${provider} is registered and has no driver`)
  return driver
}

async function silence(provider: string, driver: ProviderLiveDriver, launchEnv: NodeJS.ProcessEnv, dir: string, pidFile: string): Promise<void> {
  const id = randomUUID()
  const clock = makeClock()
  const mark = spawned.length
  const started = withStartupClock(clock, () => driver.start(dir, admitted(provider, {
    conversationId: id,
    emit: () => {},
    mcpSnapshot: async () => ({ cwd: dir, generatedAt: Date.now(), servers: [], providers: [] }),
  }, { env: launchEnv }))).then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }))
  try {
    await until(`${provider} armed a silence timer`, async () => {
      const done = await Promise.race([started.then(() => true), delay(20).then(() => false)])
      return clock.armed > 0 || done
    }, 20_000)
    if (clock.armed === 0) {
      const settled = await started
      const detail = settled.ok ? "start resolved" : settled.error instanceof Error ? settled.error.message : String(settled.error)
      throw new Error(`${provider} armed no silence timer: ${detail}`)
    }
    const wrote = await readFile(pidFile, "utf8").then((text) => text.includes("\"pid\""), () => false)
    if (!wrote) {
      await until(`${provider}'s silent peer writes its pid`, () => readFile(pidFile, "utf8").then((text) => text.includes("\"pid\""), () => false), 5_000).catch((cause: unknown) => {
        const seen = spawned.slice(mark).map((event) => event.executable).join(", ") || "nothing"
        throw new Error(`${provider}'s silent peer never started; spawned ${seen}`, { cause })
      })
    }
    clock.advance(STARTUP_SILENCE_MS)
    const settled = await started
    assert.equal(settled.ok, false, `${provider}: a silent peer resolves start`)
    const error = settled.error
    assert.ok(error instanceof Error, `${provider}: ${String(error)}`)
    assert.match(error.message, /produced no output for .+ during /, error.message)
    console.log(`${provider}: ${error.message}`)
  } finally {
    await Promise.resolve(driver.close(id)).catch(() => {})
    const recorded = await readFile(pidFile, "utf8").then((text) => z.object({ pid: z.number() }).safeParse(JSON.parse(text)).data, () => undefined)
    const pid = recorded?.pid
    if (pid && !reaped(pid)) { try { process.kill(pid, "SIGKILL") } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true })
  }
}

async function startup(): Promise<void> {
  const ids = registeredHarnessIds()
  const covered = ["codex", "grok", "devin", "claude", "opencode", "cursor"]
  assert.deepEqual([...ids].sort(), [...covered].sort(), "a registered harness has no silent peer")
  for (const provider of ids) {
    const made = await peer(provider, "hang")
    if (provider === "codex") {
      const executable = join(made.dir, "codex")
      await shell(executable, made.env)
      await withProcessEnv({ CODEX_EXECUTABLE: executable }, () => silence(provider, registered(provider), { ...process.env, CODEX_EXECUTABLE: executable }, made.dir, made.pids))
    } else if (provider === "opencode") {
      const executable = join(made.dir, "opencode")
      await shell(executable, made.env)
      await withProcessEnv({ OPENCODE_BIN_PATH: executable }, () => silence(provider, registered(provider), { ...process.env, OPENCODE_BIN_PATH: executable }, made.dir, made.pids))
    } else if (provider === "grok") {
      const executable = join(made.dir, "grok")
      await shell(executable, made.env)
      const path = `${made.dir}${process.env.PATH ? `:${process.env.PATH}` : ""}`
      await withProcessEnv({ PATH: path }, () => silence(provider, registered(provider), { ...process.env, PATH: path }, made.dir, made.pids))
    } else if (provider === "devin") {
      const executable = join(made.dir, "devin")
      await shell(executable, { ...made.env, MAKO_STANDIN_HANDSHAKE_VERSION: "0.0.0-dev" })
      await withProcessEnv({ DEVIN_CLI_PATH: executable }, () => silence(provider, registered(provider), { ...process.env, DEVIN_CLI_PATH: executable }, made.dir, made.pids))
    } else if (provider === "claude") {
      const executable = join(made.dir, "claude")
      await shell(executable, made.env)
      const driver = createClaudeSdkDriver({
        available: () => true,
        configDir: () => join(made.dir, "claude-config"),
        configure: async (cwd) => ({ options: { cwd, pathToClaudeCodeExecutable: executable, env: { ...process.env, ...made.env } }, account: { name: "default" } }),
        query: async (input) => query(input),
      })
      await silence(provider, driver, { ...process.env, ...made.env }, made.dir, made.pids)
    } else {
      let extra: NodeJS.ProcessEnv = {}
      const driver = createCursorSdkDriver({
        stores: nativeStores,
        auth: new CursorSdkAuth({
          env: async () => ({ CURSOR_API_KEY: "key_fixture_0123456789abcdef" }),
          openUrl: async () => { throw new Error("The stand-in does not sign in") },
          credentials: new CursorCredentialStore(memorySecrets({ durable: false })),
          cliKey: async () => null,
        }),
        stateRoot: () => join(made.dir, "cursor-state"),
        home: made.dir,
        client: (options) => new CursorSdkClient({ ...options, entry: FIXTURE, env: { ...options.env, ...extra, ELECTRON_RUN_AS_NODE: "1" } }),
      })
      extra = made.env
      await silence(provider, driver, { ...process.env, CURSOR_API_KEY: "key_fixture_0123456789abcdef" }, made.dir, made.pids)
    }
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })
}

async function crash(): Promise<void> {
  const allowed = new Set(["accounts-common.ts", "retained-approval-decisions.ts"])
  const writers = sourceFiles(HARNESS_SRC).filter((path) => readFileSync(path, "utf8").includes("writeFile("))
  for (const path of writers) {
    const name = path.split("/").pop() ?? path
    assert.ok(allowed.has(name), `${path} writes a file beside the publisher`)
  }
  const dir = await mkdtemp(join(tmpdir(), "mako-conform-append-"))
  try {
    const store = new RetainedApprovalDecisions(dir)
    const decision = { identity: { scope: store.scope, sessionId: "session", requestId: "request" }, answerDigest: "a".repeat(64), observedAt: 1 }
    await store.record(decision)
    await store.close()
    await appendFile(join(dir, `${store.scope}.jsonl`), "{\"interrupted\":")
    assert.deepEqual(await readRetainedApprovalDecisions(dir, [decision.identity]), [decision], "a torn final line drops the lines that finished")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function row(pid: number, ppid: number, rssKb: number): ProcessRow {
  return { pid, ppid, rssKb, cpuPercent: 0, cpuSeconds: 1, command: "agent" }
}

async function cost(): Promise<void> {
  const before = spawned.length
  const codex = await peer("codex", "hang")
  const grok = await peer("grok", "hang")
  const codexBin = join(codex.dir, "codex")
  const grokBin = join(grok.dir, "grok")
  await shell(codexBin, codex.env)
  await shell(grokBin, grok.env)
  const codexId = randomUUID()
  const grokId = randomUUID()
  const clock = makeClock()
  const startOne = (provider: string, id: string, dir: string, env: NodeJS.ProcessEnv) => withStartupClock(clock, () => registered(provider).start(dir, admitted(provider, {
    conversationId: id,
    emit: () => {},
    mcpSnapshot: async () => ({ cwd: dir, generatedAt: Date.now(), servers: [], providers: [] }),
  }, { env }))).then(() => undefined, (error) => { throw new Error(`${provider}: ${error instanceof Error ? error.message : String(error)}`) })
  const path = `${grok.dir}${process.env.PATH ? `:${process.env.PATH}` : ""}`
  await withProcessEnv({ CODEX_EXECUTABLE: codexBin, PATH: path }, async () => {
  const pending = [
    startOne("codex", codexId, codex.dir, { ...process.env, CODEX_EXECUTABLE: codexBin }),
    startOne("grok", grokId, grok.dir, { ...process.env, PATH: path }),
  ]
  try {
    await Promise.race([
      until("both peers launched", async () => {
        const files = await Promise.all([
          readFile(codex.pids, "utf8").then((text) => text, () => ""),
          readFile(grok.pids, "utf8").then((text) => text, () => ""),
        ])
        return files.every((text) => text.includes("pid"))
      }, 20_000),
      Promise.all(pending).then(() => { throw new Error("both starts settled before either peer wrote its pid") }),
    ])
    const pidOf = (text: string) => z.object({ pid: z.number() }).parse(JSON.parse(text)).pid
    const codexPid = pidOf(await readFile(codex.pids, "utf8"))
    const grokPid = pidOf(await readFile(grok.pids, "utf8"))
    assert.notEqual(codexPid, grokPid, "two conversations share a process")
    const mine = spawned.slice(before)
    const codexOwner = mine.find((event) => event.pid === codexPid)
    const grokOwner = mine.find((event) => event.pid === grokPid)
    assert.ok(codexOwner && grokOwner, "a conversation's process was not recorded")
    assert.equal(codexOwner.owner, codexId)
    assert.equal(grokOwner.owner, grokId)
    const shared = 900_000_001
    const owned = [
      { pid: codexPid, owner: codexId },
      { pid: grokPid, owner: grokId },
      { pid: shared, owner: codexId },
      { pid: shared, owner: grokId },
    ]
    const rows = [row(codexPid, 1, 1000), row(900_000_002, codexPid, 2000), row(grokPid, 1, 3000), row(900_000_003, grokPid, 4000), row(shared, 1, 5000)]
    let at = 0
    const sampler = new FinCostSampler({ table: async () => rows, owned: () => owned, now: () => at })
    const fins = [{ conversation: codexId, harness: "codex" }, { conversation: grokId, harness: "grok" }]
    assert.deepEqual(await sampler.sample(fins), [])
    at = 2_000
    const readings = await sampler.sample(fins)
    assert.equal(readings[0]?.memoryBytes, (1000 + 2000 + 5000) * 1024, "codex is charged for grok's child, or not for the shared process")
    assert.equal(readings[1]?.memoryBytes, (3000 + 4000 + 5000) * 1024, "grok is charged for codex's child, or not for the shared process")
    console.log("fin cost: two trees, the shared process charged to both")
  } finally {
    clock.advance(STARTUP_SILENCE_MS)
    await Promise.all(pending.map((started) => started.catch(() => undefined)))
    await Promise.resolve(registered("codex").close(codexId)).catch(() => {})
    await Promise.resolve(registered("grok").close(grokId)).catch(() => {})
    for (const file of [codex.pids, grok.pids]) {
      const recorded = await readFile(file, "utf8").then((text) => z.object({ pid: z.number() }).safeParse(JSON.parse(text)).data, () => undefined)
      if (recorded?.pid && !reaped(recorded.pid)) { try { process.kill(recorded.pid, "SIGKILL") } catch { /* already gone */ } }
    }
    await rm(codex.dir, { recursive: true, force: true })
    await rm(grok.dir, { recursive: true, force: true })
  }
  })
}

async function cursorCancel(): Promise<void> {
  const made = await peer("cursor", "hang-on-prompt")
  let extra: NodeJS.ProcessEnv = {}
  const driver = createCursorSdkDriver({
    stores: nativeStores,
    auth: new CursorSdkAuth({
      env: async () => ({ CURSOR_API_KEY: "key_fixture_0123456789abcdef" }),
      openUrl: async () => { throw new Error("The stand-in does not sign in") },
      credentials: new CursorCredentialStore(memorySecrets({ durable: false })),
      cliKey: async () => null,
    }),
    stateRoot: () => join(made.dir, "cursor-state"),
    home: made.dir,
    client: (options) => new CursorSdkClient({ ...options, entry: FIXTURE, env: { ...options.env, ...extra, ELECTRON_RUN_AS_NODE: "1" } }),
  })
  extra = made.env
  const id = randomUUID()
  let session: LiveSessionState | undefined
  const started = driver.start(made.dir, admitted("cursor", {
    conversationId: id,
    emit: (event) => { if (event.type === "live-session") session = event.session },
    mcpSnapshot: async () => ({ cwd: made.dir, generatedAt: Date.now(), servers: [], providers: [] }),
  }, { env: { ...process.env, CURSOR_API_KEY: "key_fixture_0123456789abcdef" } }))
  try {
    await started
    const prompting = driver.prompt(id, "hang here", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    prompting.catch(() => {})
    await until("cursor's turn is running", () => session?.status === "running")
    await driver.cancel(id)
    await until("cursor leaves the running turn", () => session?.status !== "running")
    console.log(`cursor: cancel left the session ${session?.status}`)
  } finally {
    await Promise.resolve(driver.close(id)).catch(() => {})
    const recorded = await readFile(made.pids, "utf8").then((text) => z.object({ pid: z.number() }).safeParse(JSON.parse(text)).data, () => undefined)
    if (recorded?.pid) await until("cursor's stand-in ends", () => reaped(recorded.pid!)).catch(() => { process.kill(recorded.pid!, "SIGKILL") })
    await rm(made.dir, { recursive: true, force: true })
  }
}

interface Model {
  url: string
  heard: string[]
  release(): void
  close(): Promise<void>
}

async function modelFor(harness: string, reply: (heard: string) => ScriptedReply | Promise<ScriptedReply | undefined>): Promise<Model> {
  if (harness === "devin") return scriptedWindsurf({ reply })
  return scriptedModel({ reply, answers: SCRIPTED_GETS })
}

function allow(driver: ProviderLiveDriver, id: string, event: LiveDriverEvent): void {
  if (event.type !== "live-permission") return
  const option = event.request.options?.find((candidate) => /allow/i.test(`${candidate.kind} ${candidate.optionId}`)) ?? event.request.options?.[0]
  if (option) void Promise.resolve(driver.permission(id, event.request.id, { kind: "choice", optionId: option.optionId }, { assertCurrent() {}, report() {} })).catch(() => {})
}

async function treeBytes(): Promise<number> {
  const rows = await readProcessTable()
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  let bytes = 0
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (/^ps\b|\/ps |esbuild/.test(child.command)) continue
      bytes += child.rssKb * 1024
      walk(child.pid)
    }
  }
  walk(process.pid)
  return bytes
}

async function live(harness: string, driver: ProviderLiveDriver): Promise<void> {
  await sandboxed("mako-conformance", harness, async (sandbox) => {
    const gate = { armed: true, release: (_reply: ScriptedReply) => {} }
    const model = await modelFor(harness, (heard) => {
      if (gate.armed) {
        gate.armed = false
        return new Promise<ScriptedReply>((resolve) => { gate.release = resolve })
      }
      return { text: heard.includes("mako-steer") ? "Heard." : "Noted." }
    })
    const release = () => gate.release({ text: "Noted." })
    try {
      await cancelAndSteer(harness, driver, sandbox, model, release, () => { gate.armed = true })
      await memory(harness, driver, sandbox, model)
    } finally {
      release()
      model.release()
      await model.close()
    }
  })
}

async function open(harness: string, driver: ProviderLiveDriver, sandbox: Sandbox, model: Model, emit: (event: LiveDriverEvent) => void): Promise<{ id: string; session: () => LiveSessionState | undefined }> {
  const id = randomUUID()
  const env = { ...sandbox.env }
  await pointAt(harness, sandbox, model.url, env, "conformance")
  if (harness === "claude") Object.assign(env, { CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "conformance" })
  let session: LiveSessionState | undefined
  await driver.start(sandbox.project, admitted(harness, {
    conversationId: id,
    emit: (event) => { if (event.type === "live-session") session = event.session; emit(event); allow(driver, id, event) },
    mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
  }, { env }))
  return { id, session: () => session }
}

async function cancelAndSteer(harness: string, driver: ProviderLiveDriver, sandbox: Sandbox, model: Model, release: () => void, arm: () => void): Promise<void> {
  const mark = spawned.length
  const opened = await open(harness, driver, sandbox, model, () => {})
  const prompting = driver.prompt(opened.id, "Wait for the next instruction.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
  prompting.catch(() => {})
  let steeredId = ""
  try {
    await until(`${harness} asks the model`, () => model.heard.length > 0)
    await driver.cancel(opened.id)
    release()
    await until(`${harness} leaves the running turn`, () => {
      const status = opened.session()?.status
      return status !== undefined && status !== "running" && status !== "starting"
    })
    const status = opened.session()?.status
    assert.notEqual(status, "running", `${harness} stays running after cancel`)
    if (status !== "closed" && status !== "failed") {
      let refused: unknown
      const again = driver.prompt(opened.id, "Continue.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
      again.catch((error) => { refused = error })
      await until(`${harness} accepts a prompt after cancel`, () => {
        const next = opened.session()?.status
        return refused !== undefined || model.heard.length > 1 || next === "running" || next === "closed"
      })
      if (refused !== undefined) {
        const message = refused instanceof Error ? refused.message : String(refused)
        if (!/disconnected|closed/i.test(message)) throw new Error(`${harness} refused a prompt after cancel: ${message}`)
      }
    }
    console.log(`${harness}: cancel left the session ${opened.session()?.status}`)
    await Promise.resolve(driver.close(opened.id)).catch(() => {})
    model.release()
    arm()
    const token = `mako-steer-${randomUUID()}`
    const steered = await open(harness, driver, sandbox, model, () => {})
    steeredId = steered.id
    const next = driver.prompt(steered.id, "Answer when you can.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    next.catch(() => {})
    await until(`${harness} is mid-turn`, () => model.heard.length > 0)
    const steering = driver.steering
    if (steering.kind !== "supported") throw new Error(`${harness} declares no steering`)
    const runId = steered.session()?.nativeRunId ?? ""
    const taken = await steering.steer(steered.id, { id: randomUUID(), expectedRunId: runId, text: token, attachments: [] })
    if (taken.kind !== "accepted") throw new Error(`${harness} did not accept the steer: ${taken.reason}`)
    release()
    await until(`${harness}'s model is asked the steer`, () => model.heard.some((heard) => heard.includes(token)))
    console.log(`${harness}: the steer was in what the model was asked next`)
    await Promise.resolve(driver.close(steered.id)).catch(() => {})
  } finally {
    release()
    await Promise.resolve(driver.close(opened.id)).catch(() => {})
    if (steeredId) await Promise.resolve(driver.close(steeredId)).catch(() => {})
    for (const event of spawned.slice(mark)) {
      if ((event.owner === opened.id || event.owner === steeredId) && !reaped(event.pid)) {
        try { process.kill(event.pid, "SIGKILL") } catch { /* already gone */ }
      }
    }
  }
}

async function memory(harness: string, driver: ProviderLiveDriver, sandbox: Sandbox, model: Model): Promise<void> {
  model.release()
  const opened = await open(harness, driver, sandbox, model, () => {})
  const listed = join(sandbox.home, "turn-tokens.txt")
  const rss: number[] = []
  const heap: number[] = []
  // One string, not a pair of pieces. A heap snapshot lists the pieces separately, so a search for the whole would miss it.
  const sentinel = Buffer.from(`mako-sentinel-${randomUUID()}`, "utf8").toString("utf8")
  const pinned = { sentinel }
  try {
    for (let n = 1; n <= TURNS; n += 1) {
      const token = Buffer.from(`mako-turn-${harness}-${n}-${randomUUID()}`, "utf8").toString("utf8")
      appendFileSync(listed, `${token}\n`)
      const before = model.heard.length
      const prompting = driver.prompt(opened.id, `${token} Reply with ok.`, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
      prompting.catch(() => {})
      await until(`${harness} turn ${n} asks`, () => model.heard.length > before)
      let settled = 0
      await until(`${harness} turn ${n} settles`, () => {
        settled = opened.session()?.status === "ready" ? settled + 1 : 0
        return settled >= 4
      })
      rss.push(Math.round(await treeBytes() / 1024 / 1024))
      collect()
      heap.push(Math.round(process.memoryUsage().heapUsed / 1024 / 1024))
    }
    model.release()
    collect()
    const snap = join(sandbox.home, "heap.heapsnapshot")
    writeHeapSnapshot(snap)
    const body = readFileSync(snap)
    assert.ok(body.includes(pinned.sentinel), "the snapshot cannot see a live string, so it cannot prove what the heap dropped")
    const tokens = readFileSync(listed, "utf8").trim().split("\n")
    const kept = harness === "opencode" ? OPENCODE_WINDOW : 1
    const gone = tokens.slice(0, Math.max(0, tokens.length - kept))
    for (const token of gone) assert.ok(!body.includes(token), `${harness} retains ${token} after ${TURNS} turns and a collection`)
    console.log(`${harness}: rss MB ${rss.join(" ")}; heap MB ${heap.join(" ")}; ${gone.length} earlier turns absent from the heap`)
  } finally {
    await Promise.resolve(driver.close(opened.id)).catch(() => {})
  }
}

const drivers = sealedDrivers([installClaude, installCodex, installOpenCode, installGrok, installDevin])

await startup()
await crash()
await cost()
await cursorCancel()
for (const harness of ["claude", "codex", "opencode", "grok", "devin"]) {
  const driver = drivers.get(harness)
  if (!driver) throw new Error(`${harness} has no sealed driver`)
  if (!driver.available(process.cwd())) {
    console.log(`${harness}: sections 2, 5 and 6 skipped, the CLI is not installed`)
    continue
  }
  await live(harness, driver)
}
console.log("cursor: sections 5 and 6 stay on the opt-in probe that uses the person's sign-in")
console.log("harness conformance passed")
