import "./lib/scratch-git.mjs"
// What every registered harness owes, through ProviderLiveDriver:
// a silent peer fails startup and names the step, a whole-file write goes
// through the publisher, two conversations are charged for their own process
// trees, and, where the CLI is installed, cancel, a heap after a collection,
// and a steer into a running turn behave as docs/harness-conformance.md says.
// Vendor RSS is printed and never fails the run. There is no timing budget;
// a step that never finishes hits the hang guard.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { chmod, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises"
import { appendFileSync, readdirSync, readFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { topic } from "@mako/host/base/topic"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { STARTUP_SILENCE_MS, withStartupClock, type StartupClock } from "@mako/host/harnesses/provider-startup"
import { FinCostSampler } from "@mako/host/conversations/fin-cost-sampler"
import type { ProcessRow } from "@mako/host/usage/mako-footprint"
import { readProcessTable } from "@mako/host/usage/mako-footprint"
import { readRetainedApprovalDecisions, RetainedApprovalDecisions } from "@mako/host/harnesses/retained-approval-decisions"
import { z } from "zod"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed, type Sandbox } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"
import { scriptedWindsurf } from "./scripted-windsurf.ts"
import { registeredHarnessIds } from "./registered-harnesses.ts"
import { leftOpen } from "./open-resources.ts"
import { BEHIND_A_VIEW, behindAViewText, controlText, heapMarkers, plantControls, REPRESENTATIONS } from "./heap-markers.ts"

const FIXTURE = fileURLToPath(new URL("./fixtures/native-failure-agent.mjs", import.meta.url))
const STDIO_CHILD = fileURLToPath(new URL("./fixtures/open-stdio-child.ts", import.meta.url))
const HARNESS_SRC = fileURLToPath(new URL("../packages/host/src/harnesses", import.meta.url))
const HANG = 90_000
const TURNS = 12
/** Prompts a snapshot may still hold. OpenCode keeps a window of the last 11; everyone else keeps the one in hand. */
const OPENCODE_WINDOW = 11
/** What every piece of text the heap check plants starts with. */
const HEAP_MARK = "mako-heap-"
const CURSOR_KEY = "key_fixture_0123456789abcdef"
const nativeStores = new NativeStores(false)
const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))
/** Every registered harness's live driver, from the one list the host installs: a harness is here because it registered. */
const drivers = sealedDrivers()

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
  const driver = drivers.get(provider)
  if (!driver) throw new Error(`${provider} is registered and has no live driver of its own`)
  return driver
}

/**
 * What the suite needs of each harness beyond its driver: how to put a stand-in that speaks its wire where its
 * registered driver looks for the CLI, and, when the live sections can't run here, why. A registered harness
 * without an entry fails the run; it is never tested through another harness's driver.
 */
interface Conformance {
  /** The process environment that points the registered driver at the stand-in, written into `dir`, that `env` drives. */
  standIn(dir: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>
  /** Why cancel, steer and the heap stay off this suite, when they do. */
  liveElsewhere?: string
}

const onPath = (dir: string) => `${dir}${process.env.PATH ? `:${process.env.PATH}` : ""}`
const CONFORMANCE = new Map<string, Conformance>([
  ["claude", {
    standIn: async (dir, env) => {
      await shell(join(dir, "claude"), env)
      return { CLAUDE_CODE_EXECUTABLE: join(dir, "claude"), CLAUDE_CONFIG_DIR: join(dir, "claude-config") }
    },
  }],
  ["codex", {
    standIn: async (dir, env) => {
      await shell(join(dir, "codex"), env)
      return { CODEX_EXECUTABLE: join(dir, "codex") }
    },
  }],
  ["cursor", {
    standIn: async (_dir, env) => ({ ...env, CURSOR_SDK_CHILD: FIXTURE, CURSOR_API_KEY: CURSOR_KEY }),
    liveElsewhere: "sections 5 and 6 stay on the opt-in probe that uses the person's sign-in",
  }],
  ["opencode", {
    standIn: async (dir, env) => {
      await shell(join(dir, "opencode"), env)
      return { OPENCODE_BIN_PATH: join(dir, "opencode") }
    },
  }],
  ["grok", {
    standIn: async (dir, env) => {
      await shell(join(dir, "grok"), env)
      return { PATH: onPath(dir) }
    },
  }],
  ["devin", {
    standIn: async (dir, env) => {
      await shell(join(dir, "devin"), { ...env, MAKO_STANDIN_HANDSHAKE_VERSION: "0.0.0-dev" })
      return { DEVIN_CLI_PATH: join(dir, "devin") }
    },
  }],
])

function conformance(provider: string): Conformance {
  const entry = CONFORMANCE.get(provider)
  if (!entry) throw new Error(`${provider} is registered and has no stand-in for its wire in CONFORMANCE`)
  return entry
}

/** Why `ids` can't be tested as registered, if they can't: a harness without its own driver or entry, or an entry for none. */
function unmatched(ids: readonly string[], live: readonly string[], table: readonly string[]): string[] {
  return [
    ...ids.filter((id) => !live.includes(id)).map((id) => `${id} is registered and has no live driver of its own`),
    ...ids.filter((id) => !table.includes(id)).map((id) => `${id} is registered and has no stand-in for its wire in CONFORMANCE`),
    ...live.filter((id) => !ids.includes(id)).map((id) => `${id} has a live driver and isn't registered`),
    ...table.filter((id) => !ids.includes(id)).map((id) => `CONFORMANCE has ${id}, which isn't registered`),
  ]
}

/** Every registered harness, each with its own driver and its own conformance entry, and no entry for anything else. */
function harnesses(): string[] {
  const ids = registeredHarnessIds()
  // A harness registered with no driver of its own fails here, never tested through another's.
  assert.deepEqual(unmatched([...ids, "future"], [...drivers.keys()], [...CONFORMANCE.keys()]), [
    "future is registered and has no live driver of its own",
    "future is registered and has no stand-in for its wire in CONFORMANCE",
  ])
  assert.deepEqual(unmatched(ids, [...drivers.keys()], [...CONFORMANCE.keys()]), [], "a registered harness can't be tested through its own driver")
  return ids
}

/** Runs `work` with `provider`'s registered driver pointed at a stand-in that behaves as `behavior`. */
async function withStandIn(provider: string, behavior: string, work: (made: { dir: string; pids: string; env: NodeJS.ProcessEnv }) => Promise<void>): Promise<void> {
  const made = await peer(provider, behavior)
  const overrides = await conformance(provider).standIn(made.dir, made.env)
  const env = { ...process.env, ...overrides }
  await withProcessEnv(overrides, () => work({ dir: made.dir, pids: made.pids, env }))
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
  for (const provider of harnesses())
    await withStandIn(provider, "hang", (made) => silence(provider, registered(provider), made.env, made.dir, made.pids))
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })
}

/** Node's calls that write a whole file in place, by any spelling: imported, aliased, a method, or named in a string. */
const WHOLE_FILE_WRITER = /\b(writeFile|writeFileSync|createWriteStream|copyFile|copyFileSync|cp|cpSync)\b/g

/**
 * Each harness file that may name a whole-file writer without the publisher, how many times, and why. A new
 * writer, here or anywhere else, fails: it has to go through `publishFile`, or earn a line here.
 */
/** How many times a file may name a whole-file writer, and why it may. */
interface Allowance {
  count: number
  why: string
}

const WRITERS_BESIDE_THE_PUBLISHER = new Map<string, Allowance>([
  ["accounts-common.ts", { count: 2, why: "an empty login marker, created exclusively (`wx`): it is never rewritten" }],
  ["retained-approval-decisions.ts", { count: 1, why: "appends a line through a handle opened to append: a torn line is dropped on read" }],
  ["cursor/sdk/fork.ts", { count: 3, why: "clones a store into a new path, `cp -c -n` or `COPYFILE_EXCL`: never over a file that exists" }],
])

/** How often each file under `root` names a whole-file writer, outside comments. */
function writers(files: { path: string; text: string }[]): Map<string, number> {
  const named = new Map<string, number>()
  for (const { path, text } of files) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    const count = code.match(WHOLE_FILE_WRITER)?.length ?? 0
    if (count) named.set(path, count)
  }
  return named
}

function unlisted(named: Map<string, number>): string[] {
  return [...named].filter(([path, count]) => WRITERS_BESIDE_THE_PUBLISHER.get(path)?.count !== count).map(([path, count]) => `${path} (${count})`)
}

async function crash(): Promise<void> {
  const sources = sourceFiles(HARNESS_SRC).map((path) => ({ path: path.slice(HARNESS_SRC.length + 1), text: readFileSync(path, "utf8") }))
  assert.deepEqual(unlisted(writers(sources)), [], "a harness writes a whole file beside the publisher")
  for (const [path, { count }] of WRITERS_BESIDE_THE_PUBLISHER)
    assert.equal(writers(sources).get(path), count, `${path} no longer writes as WRITERS_BESIDE_THE_PUBLISHER says; trim its entry`)
  // The scan's own control: each spelling a new harness could use is caught.
  const spellings = [
    "import { writeFileSync } from \"node:fs\"",
    "import { writeFile as save } from \"node:fs/promises\"",
    "await fs.promises.writeFile (path, text)",
    "fs[\"writeFileSync\"](path, text)",
    "const out = createWriteStream(path)",
  ]
  for (const text of spellings)
    assert.deepEqual(unlisted(writers([{ path: "future/index.ts", text }])), ["future/index.ts (1)"], `the scan misses ${text}`)
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
    assert.equal(await sampler.sample(fins), undefined)
    at = 2_000
    const readings = await sampler.sample(fins)
    assert.ok(readings)
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
  const driver = registered("cursor")
  await withStandIn("cursor", "hang-on-prompt", async (made) => {
    const id = randomUUID()
    let session: LiveSessionState | undefined
    try {
      await driver.start(made.dir, admitted("cursor", {
        conversationId: id,
        emit: (event) => { if (event.type === "live-session") session = event.session },
        mcpSnapshot: async () => ({ cwd: made.dir, generatedAt: Date.now(), servers: [], providers: [] }),
      }, { env: made.env }))
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
  })
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
  try {
    for (let n = 1; n <= TURNS; n += 1) {
      const token = Buffer.from(`${HEAP_MARK}turn-${harness}-${n}-${randomUUID()}`, "utf8").toString("utf8")
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
    // What a harness that leaked would hold, in every form the search reads: each must be found, or the search
    // can't tell a heap that dropped the earlier turns from one it can't see into.
    const control = randomUUID()
    const controls = plantControls(`${HEAP_MARK}control-`, control)
    const found = await heapMarkers(HEAP_MARK, join(sandbox.home, "heap.heapsnapshot"))
    controls.release()
    for (const kind of REPRESENTATIONS)
      assert.ok(found.some((hit) => hit.in === kind && hit.text === controlText(`${HEAP_MARK}control-`, kind, control)), `the heap search can't see text kept as a ${kind}, so it can't prove what the heap dropped`)
    for (const kind of BEHIND_A_VIEW)
      assert.ok(found.some((hit) => hit.in === kind && hit.text === behindAViewText(`${HEAP_MARK}control-`, kind, control)), `the heap search can't see text in a ${kind} a small view keeps, so it can't prove what the heap holds`)
    const tokens = readFileSync(listed, "utf8").trim().split("\n")
    const kept = harness === "opencode" ? OPENCODE_WINDOW : 1
    const gone = tokens.slice(0, Math.max(0, tokens.length - kept))
    for (const token of gone) {
      const held = found.filter((hit) => hit.text.startsWith(token)).map((hit) => hit.in)
      assert.deepEqual(held, [], `${harness} retains ${token} after ${TURNS} turns and a collection, as a ${held.join(", ")}`)
    }
    console.log(`${harness}: rss MB ${rss.join(" ")}; heap MB ${heap.join(" ")}; ${gone.length} earlier turns absent from its strings and bytes`)
  } finally {
    await Promise.resolve(driver.close(opened.id)).catch(() => {})
  }
}

/** Stops every driver this run touched, and the host's, so nothing they own outlives the run. */
async function stopAll(): Promise<void> {
  for (const driver of [...drivers.values(), ...providerHost.liveDrivers.list()]) await Promise.resolve(driver.stop?.()).catch(() => {})
}

/**
 * Fails the run when anything still keeps Node running once every driver is stopped: a worker, a port, a server, a
 * process or a timer a driver left behind would hold a real host's event loop the same way. Closing is
 * asynchronous, so it waits for what is closing, up to the hang guard; anything still there is named.
 */
async function nothingLeftOpen(ms = 20_000): Promise<void> {
  await until("every handle the drivers opened closes", () => leftOpen().length === 0, ms).catch(() => {
    throw new Error(`still open after every driver stopped: ${leftOpen().join(", ")}`)
  })
}

/** What the guard is for: each of these left running has to fail it, so it can't pass by not looking. */
async function leftOpenControls(): Promise<void> {
  const interval = setInterval(() => {}, 1_000)
  await assert.rejects(nothingLeftOpen(100), /still open after every driver stopped: Timeout$/, "a referenced interval left running fails the guard")
  clearInterval(interval)
  const child = spawn("sleep", ["30"])
  await assert.rejects(nothingLeftOpen(100), /still open after every driver stopped: .*ProcessWrap/, "a process left running fails the guard")
  child.kill("SIGKILL")
  setTimeout(() => {}, 60_000).unref()
  await nothingLeftOpen()
  await stdioControls()
}

/** What the guard reads in a process with pipes for stdio, ended or not: only the run's own may be left out, and only while they're there. */
async function stdioControls(): Promise<void> {
  const reads = async (stdin: "ended" | "open", path: string): Promise<string[]> => {
    const child = spawn(process.execPath, [STDIO_CHILD, stdin, path], { stdio: "pipe" })
    if (stdin === "ended") child.stdin.end()
    let printed = ""
    child.stdout.on("data", (chunk: Buffer) => { printed += chunk.toString() })
    const [code] = await once(child, "close")
    assert.equal(code, 0, "the stdio control ran")
    return z.array(z.string()).parse(JSON.parse(printed))
  }
  const path = join(await mkdtemp(join(tmpdir(), "mako-open-stdio-")), "peer")
  const peer: Server = createServer()
  await new Promise<void>((resolve) => peer.listen(path, resolve))
  peer.on("connection", (socket) => { socket.on("error", () => {}) })
  try {
    assert.deepEqual(await reads("ended", ""), [], "a run's own stdio is never a leak, its stdin ended")
    assert.deepEqual(await reads("open", ""), [], "nor with its stdin open")
    assert.deepEqual(await reads("open", path), ["PipeWrap"], "a pipe of someone else's is found beside an open stdin")
    assert.deepEqual(await reads("ended", path), ["PipeWrap"], "and an ended stdin doesn't stand in for it")
  } finally {
    await new Promise((resolve) => peer.close(resolve))
    await rm(dirname(path), { recursive: true, force: true })
  }
}

try {
  await startup()
  await crash()
  await cost()
  await cursorCancel()
  for (const harness of harnesses()) {
    const driver = registered(harness)
    const elsewhere = conformance(harness).liveElsewhere
    if (elsewhere) {
      console.log(`${harness}: ${elsewhere}`)
      continue
    }
    if (!driver.available(process.cwd())) {
      console.log(`${harness}: sections 2, 5 and 6 skipped, the CLI is not installed`)
      continue
    }
    await live(harness, driver)
  }
} finally {
  await stopAll()
}
await nothingLeftOpen()
await leftOpenControls()
console.log("harness conformance passed")
