import "./lib/scratch-git.mjs"
// What a person does with a session, against every installed harness's real
// CLI, through an isolated host built the way the app builds its own.
//
//   npm run test:session-flows                       every flow a harness declares, on all six
//   npm run test:session-flows -- claude codex       only these harnesses
//   npm run test:session-flows -- --flows question,plan
//   npm run test:session-flows -- --all              also run flows a harness doesn't declare, to check the declaration
//   npm run test:session-flows -- --record <dir>     leave sessions idle, mid-question and mid-plan in <dir>
//   npm run test:session-flows -- --continue <dir>   reopen and continue those sessions with this build
//   npm run test:session-flows -- --bench            what a growing conversation costs each harness; see session-flows-bench.mjs
//   npm run test:session-flows -- --stand-in         only a seventh harness with a scripted agent (fixtures/stand-in-harness.mjs); spends nothing
//   npm run test:session-flows -- --no-restart       skip the restart flow, for a harness pointed at its own isolated store, whose
//                                                    processes the activity probe can't inventory, so a resume is refused
//
// `--record` before a change and `--continue` after it is the "install the
// new build, then follow up in an old conversation" case. Uses normal
// selected-account routing and each harness's work default; spends a few
// short turns per harness. Never copies credentials or resends an uncertain prompt.
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { imageFixture } from "./provider-e2e-fixtures.mjs"
import { benchFlows, historyProbe, resumeImported } from "./session-flows-bench.mjs"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { REVIEW_FENCE, makoReviewReport } from "@mako/sessions/review"

const nativeStores = new NativeStores(false)

const FLOW_MS = 6 * 60_000
const ACTIVE = new Set(["queued", "held", "dispatching"])

if (!process.versions.electron) {
  const args = process.argv.slice(2)
  const dir = (flag) => { const at = args.indexOf(flag); return at >= 0 ? resolve(args[at + 1] ?? "") : undefined }
  const kept = dir("--record") ?? dir("--continue")
  const root = kept ?? await mkdtemp(join(tmpdir(), "mako-session-flows-"))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-session-flows", main: fileURLToPath(import.meta.url) }))
  console.log(`Session flows: ${root}`)
  const env = { ...process.env, MAKO_FLOWS_ROOT: root, MAKO_FLOWS_REPO: resolve("."), MAKO_FLOWS_ARGS: JSON.stringify(args) }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { env, stdio: "inherit" })
  const [code] = await once(child, "exit")
  // Every session the run made: its stream bound to the session's id, held whole by the record store, drawing what its store draws.
  const streams = existsSync(join(root, "report.json")) && JSON.parse(await readFile(join(root, "report.json"), "utf8")).sessions?.length
    ? spawn(resolve("node_modules/.bin/tsx"), ["--tsconfig", "tsconfig.app.json", "scripts/check-streams.ts", root], { stdio: "inherit" })
    : null
  const [checked] = streams ? await once(streams, "exit") : [0]
  process.exitCode = code || checked || 0
} else {
  const { app } = await import("electron")
  const unhandled = []
  process.on("unhandledRejection", (reason) => {
    unhandled.push(reason)
    console.error("Unhandled rejection in the host:", reason?.stack ?? reason)
  })
  // A listener added per turn or per call to one long-lived emitter is a leak; its stack names who adds it.
  process.on("warning", (warning) => {
    if (warning.name !== "MaxListenersExceededWarning") return
    unhandled.push(warning)
    console.error("Listener leak in the host:", warning.stack)
  })
  void main(app).then(() => {
    if (unhandled.length) throw new Error(`The host left ${unhandled.length} unhandled rejection(s) or listener leak(s)`)
  }).then(() => app.exit(0), (error) => { console.error(error.message); app.exit(1) })
}

function options() {
  const args = JSON.parse(process.env.MAKO_FLOWS_ARGS ?? "[]")
  const value = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined }
  const valued = new Set(["--flows", "--record", "--continue"].flatMap((flag) => { const at = args.indexOf(flag); return at >= 0 ? [at + 1] : [] }))
  return {
    harnesses: args.filter((arg, index) => !arg.startsWith("--") && !valued.has(index)),
    flows: value("--flows")?.split(","),
    all: args.includes("--all"),
    standIn: args.includes("--stand-in"),
    noRestart: args.includes("--no-restart"),
    mode: args.includes("--record") ? "record" : args.includes("--continue") ? "continue" : args.includes("--bench") ? "bench" : "run",
  }
}

async function main(app) {
  const root = process.env.MAKO_FLOWS_ROOT
  const repo = process.env.MAKO_FLOWS_REPO
  const chosen = options()
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const load = (path) => import(join(repo, path))
  const { createHarnessHost, detachedHarnessContext } = await load("packages/host/dist/harnesses/harness-host.js")
  const harnessContext = detachedHarnessContext(nativeStores, root)
  const providerHost = createHarnessHost({ ...harnessContext, streams: join(root, "streams") })
  const { LiveConversations } = await load("packages/host/dist/conversations/live-conversations.js")
  const { assessProviderResume } = await load("packages/host/dist/harnesses/provider-recovery.js")
  const stopDrivers = () => {
    for (const driver of providerHost.liveDrivers.list()) driver.stop?.()
  }
  const { nativeSessionPath } = await import("@mako/host/threads/native-source")
  const { defaultCatalog, readableHarnesses, SAVED_HISTORY_READERS } = await load("packages/sessions/dist/index.js")
  const readers = [...SAVED_HISTORY_READERS]
  if (chosen.standIn) {
    const { installStandIn } = await import(join(repo, "scripts/fixtures/stand-in-harness.mjs"))
    const standIn = await installStandIn({ load, providerHost, context: harnessContext, store: join(root, "stand-in") })
    chosen.harnesses = [standIn.provider]
    readers.push(standIn.reader)
  }
  // The app pages through its catalog daemon; this host must not start or reach the user's.
  const catalog = defaultCatalog({ archivePath: join(root, "archive"), recordsPath: join(root, "records"), viewsPath: join(root, "views"), readers })
  const { SessionMemory } = await import("@mako/host/threads/session-memory")
  const { openThreadStore } = await import("@mako/host/threads/store")
  const { WorkspaceSnapshots } = await load("packages/host/dist/workspaces/snapshots.js")
  const { Git } = await load("packages/git/dist/index.js")
  const { installHostLog } = await load("packages/host/dist/base/host-log.js")
  const { StreamMismatches } = await load("packages/host/dist/base/stream-mismatches.js")
  const { identifyTool, nativeToolNames } = await load("packages/sessions/dist/tool-identity.js")
  const { ProviderChildren } = await load("packages/host/dist/base/provider-children.js")
  installHostLog(join(root, "host.log"))
  new ProviderChildren(join(root, "profile")).follow()
  // What the host's merges find, kept beside its log as the app keeps it.
  const mismatches = new StreamMismatches(root, join(root, "streams"))
  mismatches.follow()

  for (const harness of chosen.harnesses) if (!providerHost.liveDrivers.get(harness)) throw new Error(`Unregistered harness: ${harness}`)
  const memory = new SessionMemory(join(root, "memory.sqlite"), { pid: process.pid, startedAt: Date.now(), label: "session flows" })
  const { store: threads, problem } = openThreadStore(join(root, "threads.sqlite"))
  if (problem) throw new Error(`Thread store: ${problem}`)
  const git = new Git()
  const snapshots = new WorkspaceSnapshots(git, join(root, "workspace-snapshots"))
  let owner
  // What the window is sent, per conversation: a repeated non-text update is the same news delivered twice.
  const fed = new Map()
  const feed = (event) => {
    if (event.type !== "live-batch") return
    const entry = fed.get(event.batch.id) ?? { batches: 0, bytes: 0, updates: 0, text: 0, repeats: new Map(), seen: new Set() }
    fed.set(event.batch.id, entry)
    entry.harness ??= event.batch.session?.harness ?? owner?.snapshot(event.batch.id)?.session.harness
    entry.batches++
    entry.bytes += JSON.stringify(event).length
    entry.fields ??= {}
    for (const [field, value] of Object.entries(event.batch)) if (value !== undefined) entry.fields[field] = (entry.fields[field] ?? 0) + JSON.stringify(value).length
    for (const field of Object.keys(event.batch)) if (event.batch[field] !== undefined) (entry.counts ??= {})[field] = (entry.counts[field] ?? 0) + 1
    for (const [field, value] of Object.entries(event.batch.session ?? event.batch.sessionChanges ?? {})) {
      if (value === undefined) continue
      entry.fields[`session.${field}`] = (entry.fields[`session.${field}`] ?? 0) + JSON.stringify(value).length
      entry.counts[`session.${field}`] = (entry.counts[`session.${field}`] ?? 0) + 1
    }
    for (const update of event.batch.updates) {
      entry.updates++
      if (update.kind === "text" || update.kind === "thinking") { entry.text += update.text?.length ?? 0; continue }
      const key = JSON.stringify(update)
      if (entry.seen.has(key)) entry.repeats.set(update.kind, (entry.repeats.get(update.kind) ?? 0) + 1)
      else entry.seen.add(key)
    }
  }
  const host = {
    /** A host as the app builds it; a second call is the app after a restart. */
    open() {
      owner = new LiveConversations({
        appPath: app.getAppPath(), root: join(root, "conversations"), memory, threads, workspaceSnapshots: snapshots,
        driver: (provider) => providerHost.liveDrivers.get(provider),
        checkpoint: (path, provider) => providerHost.liveDrivers.get(provider)?.resume.checkpoint?.(path) ?? Promise.resolve(undefined),
        nativePath: (identity) => nativeSessionPath(identity, catalog.list()),
        history: (path, before) => catalog.page(path, before),
        staleHistory: (path, before) => catalog.page(path, before, undefined, { stale: true }),
        holdHistory: (path) => catalog.hold(path),
        resumeVerdict: (binding) => assessProviderResume(binding, providerHost.liveDrivers.get(binding.provider)),
        emitSession: async (provider, thread) => providerHost.sessionEmitters.get(provider)?.emit(thread) ?? null,
        mcpSnapshot: async (cwd) => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
        providerIdleMs: 60_000, providerWarmLimit: 2, autoContinueDelayMs: 10,
        emit: feed,
      })
      return owner
    },
    get owner() { return owner },
    /** Quit as the app does, then start a new host over the same stores. */
    async restart() {
      await owner.stop()
      stopDrivers()
      return host.open()
    },
  }
  host.open()

  const tools = { identifyTool, nativeToolNames, emitters: providerHost.sessionEmitters, harnesses: providerHost.harnesses, skills: providerHost.skillSources, readable: readableHarnesses(readers), history: (path) => catalog.page(path) }
  const bench = chosen.mode === "bench" ? benchFlows(historyProbe({ root, profile: join(root, "profile"), emitters: providerHost.sessionEmitters, fed })) : []
  const results = []
  const sessions = []
  tools.sessions = sessions
  const report = async () => {
    await writeFile(join(root, "report.json"), JSON.stringify({ scope: "Installed harness CLIs through a freshly built isolated host; not the installed Mako app", mode: chosen.mode, results, sessions, mismatches: mismatches.kinds() }, null, 2))
  }
  try {
    if (chosen.mode === "continue") await continueRecorded(root, host, providerHost, tools, results, report, await load("packages/host/dist/conversations/live-journal.js"))
    else {
      const recorded = []
      for (const driver of providerHost.liveDrivers.list()) {
        if (chosen.harnesses.length && !chosen.harnesses.includes(driver.provider)) continue
        if (!driver.available(app.getAppPath())) {
          results.push({ harness: driver.provider, flow: "all", result: "skipped", reason: "not installed" })
          continue
        }
        const harness = new Harness(driver, host, root, tools)
        const flows = chosen.mode === "record" ? RECORDED : chosen.mode === "bench" ? bench : FLOWS
        for (const flow of flows) {
          if (chosen.flows && !chosen.flows.includes(flow.name) && !flow.core) continue
          if (chosen.noRestart && flow.name === "restart") continue
          const declared = flow.declared(driver, tools)
          if (declared !== true && !chosen.all) {
            results.push({ harness: driver.provider, flow: flow.name, result: "skipped", reason: declared })
            continue
          }
          const began = Date.now()
          try {
            const evidence = await withDeadline(flow.run(harness), FLOW_MS, `${flow.name} took over ${FLOW_MS / 60_000} minutes`)
            results.push({ harness: driver.provider, flow: flow.name, result: "passed", declared: declared === true || declared, ms: Date.now() - began, ...evidence })
          } catch (error) {
            if (process.env.MAKO_FLOWS_STACKS) console.error(error.stack)
            results.push({ harness: driver.provider, flow: flow.name, result: declared === true ? "failed" : "undeclared-failed", declared: declared === true || declared, ms: Date.now() - began, reason: error.message, state: harness.describe() })
            if (flow.core) break
          } finally {
            await harness.settle(flow)
          }
          console.log(JSON.stringify(results.at(-1)))
          await report()
        }
        if (chosen.mode === "record") recorded.push(...harness.recorded)
        else await harness.closeAll()
      }
      if (chosen.mode === "record") {
        for (const entry of recorded) sessions.push(...await noted(host.owner, entry.id, root))
        await host.owner.stop()
        stopDrivers()
        await writeFile(join(root, "recorded.json"), JSON.stringify({ recordedAt: new Date().toISOString(), conversations: recorded }, null, 2))
        console.log(`Recorded ${recorded.length} conversations for --continue ${root}`)
      }
    }
  } finally {
    await report()
    await host.owner?.stop().catch(() => {})
    memory.close()
    catalog.stop()
    git.close()
  }
  const fedBy = new Map()
  for (const entry of fed.values()) {
    const harness = entry.harness ?? "?"
    const total = fedBy.get(harness) ?? { conversations: 0, batches: 0, bytes: 0, updates: 0, text: 0, repeats: {} }
    fedBy.set(harness, total)
    total.conversations++
    for (const field of ["batches", "bytes", "updates", "text"]) total[field] += entry[field]
    for (const [kind, count] of entry.repeats) total.repeats[kind] = (total.repeats[kind] ?? 0) + count
    total.counts ??= {}
    for (const [field, count] of Object.entries(entry.counts ?? {})) total.counts[field] = (total.counts[field] ?? 0) + count
    total.fields ??= {}
    for (const [field, size] of Object.entries(entry.fields ?? {})) total.fields[field] = (total.fields[field] ?? 0) + size
  }
  console.log("\nSent to the window, per harness:")
  for (const [harness, total] of fedBy) console.log(`${harness.padEnd(9)} ${total.conversations} conversations, ${total.batches} batches, ${Math.round(total.bytes / 1024)}KB for ${Math.round(total.text / 1024)}KB of text, ${total.updates} updates, repeated: ${JSON.stringify(total.repeats)}; heaviest: ${Object.entries(total.fields).filter(([field]) => field !== "session" && field !== "sessionChanges").sort((a, b) => b[1] - a[1]).slice(0, 5).map(([field, size]) => `${field} ${Math.round(size / 1024)}KB${total.counts[field] ? ` in ${total.counts[field]}` : ""}`).join(", ")}`)
  const failed = results.filter((result) => result.result === "failed")
  const table = results.map((result) => `${result.harness.padEnd(9)} ${result.flow.padEnd(14)} ${result.result}${result.reason ? `  ${result.reason}` : ""}`)
  console.log(`\n${table.join("\n")}`)
  if (failed.length) throw new Error(`${failed.length} declared flow(s) failed; no prompt was retried.`)
}

/** One harness's conversations and the person's side of them. */
class Harness {
  constructor(driver, host, root, tools) {
    this.driver = driver
    this.provider = driver.provider
    this.host = host
    this.root = root
    this.tools = tools
    this.open = new Set()
    this.recorded = []
    this.current = undefined
  }

  get owner() { return this.host.owner }
  get fullMode() { return this.driver.modes?.find((mode) => mode.access === "full")?.id }

  /** `prepare` writes into the project before the harness starts, which is when harnesses scan it. */
  async conversation(label, start = {}, prepare) {
    const id = randomUUID()
    const cwd = join(this.root, "work", this.provider, `${label}-${id.slice(0, 8)}`)
    await mkdir(cwd, { recursive: true })
    await prepare?.(cwd)
    await this.owner.start(this.provider, cwd, { conversationId: id, title: `Session flows: ${label}`, modeId: this.fullMode, ...start })
    this.open.add(id)
    this.current = id
    return { id, cwd }
  }

  snapshot(id) { return this.owner.snapshot(id) }

  /** Sends one message and waits for it to end, answering plain approvals as a person clicking Allow would. */
  async send(id, text, { attachments = [], tuning, until } = {}) {
    const requestId = randomUUID()
    this.owner.submit(id, requestId, text, attachments, tuning)
    await this.wait(id, `the message "${text.slice(0, 40)}" to end`, (snapshot) => {
      const request = snapshot?.requests.find((entry) => entry.id === requestId)
      return (until?.(snapshot, request) ?? false) || (request && !ACTIVE.has(request.status))
    })
    return requestId
  }

  async completed(id, text, options) {
    const requestId = await this.send(id, text, options)
    const request = this.request(id, requestId)
    if (request.status !== "completed") throw new Error(`The message ended ${request.status}${request.failure ? `: ${request.failure}` : ""}${request.error ? `: ${request.error}` : ""}`)
    return requestId
  }

  request(id, requestId) { return this.snapshot(id).requests.find((entry) => entry.id === requestId) }

  /** The assistant's text for one message, from its user block to the next. */
  reply(id, requestId) {
    const blocks = this.snapshot(id).blocks
    const start = blocks.findIndex((block) => block.type === "user" && block.requestId === requestId)
    if (start < 0) throw new Error("The message has no user block in the transcript")
    const end = blocks.findIndex((block, index) => index > start && block.type === "user" && !block.steeringFor)
    return blocks.slice(start + 1, end < 0 ? undefined : end).filter((block) => block.type === "text").map((block) => block.text).join("")
  }

  toolsAfter(id, requestId) {
    const blocks = this.snapshot(id).blocks
    const start = blocks.findIndex((block) => block.type === "user" && block.requestId === requestId)
    return blocks.slice(start + 1).filter((block) => block.type === "tool")
      .map((block) => ({ name: block.name, kind: this.tools.identifyTool({ harness: this.provider, name: block.name, acpKind: block.toolKind, title: block.title, input: block.input }).kind }))
  }

  async wait(id, label, predicate, ms = FLOW_MS) {
    const started = Date.now()
    for (;;) {
      const snapshot = this.snapshot(id)
      if (predicate(snapshot)) return snapshot
      await this.allow(id, snapshot)
      if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${label}`)
      await delay(100)
    }
  }

  async allow(id, snapshot) {
    for (const permission of snapshot?.permissions ?? []) {
      if (permission.questions?.length || permission.implementsPlan || this.answered?.has(permission.id)) continue
      // An always-allow saves a rule or a folder's trust in the person's own config, so a flow allows once or declines.
      const option = permission.options.find((entry) => entry.kind === "allow_once") ??
        permission.options.find((entry) => entry.kind?.startsWith("reject")) ?? permission.options.find((entry) => entry.kind !== "allow_always")
      if (!option) continue
      ;(this.answered ??= new Set()).add(permission.id)
      await this.owner.permission(id, permission.id, { kind: "choice", optionId: option.optionId })
    }
  }

  /** The question the harness asked through its own tool, however it arrived. */
  pendingQuestion(snapshot) {
    const permission = snapshot?.permissions.find((entry) => entry.questions?.length)
    if (permission) return { id: permission.id, question: permission.questions[0] }
    const asked = snapshot?.control?.questions?.find((entry) => !entry.answered && !entry.dismissed && !entry.retired)
    return asked && { id: asked.id, question: asked.native.questions[0] }
  }

  describe() {
    const snapshot = this.current && this.snapshot(this.current)
    return snapshot && {
      status: snapshot.session.status, connection: snapshot.session.connection, nativeId: snapshot.session.nativeId,
      requests: snapshot.requests.map((request) => ({ status: request.status, failure: request.failure, error: request.error, evidence: request.nativeDelivery?.evidence.kind })),
      permissions: snapshot.permissions.map((permission) => ({ title: permission.title, questions: permission.questions?.length ?? 0, implementsPlan: Boolean(permission.implementsPlan) })),
      questions: snapshot.control?.questions?.length ?? 0,
      lastBlocks: snapshot.blocks.slice(-4).map(brief),
    }
  }

  /** After a flow: close what it opened, except what the main conversation or a recording keeps. */
  async settle(flow) {
    for (const id of this.open) {
      if (id === this.main?.id || this.recorded.some((entry) => entry.id === id)) continue
      this.tools.sessions.push(...await noted(this.owner, id, this.root))
      await this.owner.close(id).catch(() => {})
      this.open.delete(id)
    }
    if (flow.name === "fork") this.current = this.main?.id
  }

  async closeAll() {
    for (const id of this.open) {
      this.tools.sessions.push(...await noted(this.owner, id, this.root))
      await this.owner.close(id).catch(() => {})
    }
    this.open.clear()
  }
}

/**
 * What `check-streams.ts` needs of a conversation the run made: the native
 * session it ran, once the harness named it, what Mako showed of it, the
 * calls Mako closed itself, and the host's merge of its record with its
 * blocks. The conversation is read from its store first, as a window
 * reading it idle does (`refreshedSnapshot`), so the host merges as it would
 * there; `merge` holds what that merge took and gave, or what it would take.
 */
async function noted(owner, id, root) {
  const before = owner.snapshot(id)
  if (!before?.session.nativeId) return []
  const viewAt = Date.now()
  const { capturedThread } = await import("@mako/host/conversations/live-context")
  const snapshot = (await owner.refreshedSnapshot(id).catch(() => null)) ?? owner.snapshot(id) ?? before
  const session = snapshot.session
  const bindings = snapshot.control?.bindings ?? []
  const binding = bindings.length === 1 ? bindings[0] : undefined
  const covered = snapshot.baseCoveredBlocks ?? 0
  const runtime = session.executionContext?.runtime
  const merge = {
    merged: covered > 0 && snapshot.baseLiveStart !== undefined,
    covered: covered || snapshot.blocks.length,
    liveStart: covered ? snapshot.baseLiveStart : before.base ? before.base.start + before.base.entries.length : 0,
    version: runtime?.kind === "reported" ? runtime.version : undefined,
    ...binding?.seeded && { seeded: binding.seeded, own: capturedThread(before, 0, true).entries },
    ...covered && snapshot.base && { base: snapshot.base.entries.slice(Math.max(0, (snapshot.baseLiveStart ?? 0) - snapshot.base.start)) },
  }
  mkdirSync(join(root, "views"), { recursive: true })
  const closed = snapshot.requests.flatMap((request) => request.interruption?.closed ?? [])
  writeFileSync(join(root, "views", `${id}.json`), JSON.stringify({ blocks: snapshot.blocks, closed, merge }))
  return [{ harness: session.harness, conversation: id, nativeId: session.nativeId, path: session.nativePath ?? null, fork: snapshot.control?.ancestry?.kind === "fork", viewAt }]
}

/** A side conversation's copy of the agent leaves the SDK's index and the disk once it closes. */
async function sideCopiesGone(provider, since) {
  if (provider !== "cursor") throw new Error(`The flows don't know where ${provider} keeps a side conversation's copy`)
  const { DatabaseSync } = await import("node:sqlite")
  const { createHash } = await import("node:crypto")
  const root = process.env.MAKO_CURSOR_SDK_ROOT ?? join(homedir(), ".mako", "cursor-sdk")
  const left = () => {
    const index = new DatabaseSync(join(root, "index.db"), { readOnly: true })
    try {
      return index.prepare("select agent_id from agents where name = 'Side question' and created_at >= ?").all(since).map((row) => row.agent_id)
    } finally {
      index.close()
    }
  }
  const onDisk = (agentId) => existsSync(join(root, "agents", `agent-${createHash("sha256").update(agentId).digest("hex")}`))
  const seen = new Set()
  for (const started = Date.now(); Date.now() - started < 15_000; await delay(250)) {
    const indexed = left()
    indexed.forEach((agentId) => seen.add(agentId))
    if (!indexed.length && ![...seen].some(onDisk)) return
  }
  throw new Error(`A side conversation's copy outlived it: ${[...seen].filter((agentId) => left().includes(agentId) || onDisk(agentId)).length} left in the index or on disk`)
}

/** A turn running a tool, steered to put a nonce in its reply, through to its end. */
/**
 * How a fork went: the harness forked its session, or it declined this one
 * (`NativeFork.declines`) or forks by import, and the conversation was
 * carried into a new native session. A transcript fallback fails.
 */
function forkWay(forked) {
  const state = forked.control?.transfers.at(-1)?.state
  if (forked.control?.ancestry?.nativeFork && !state?.nativeForkDeclined) return "native fork"
  if (state?.carried !== "native") throw new Error(`The fork went as a transcript: ${state?.fallback ?? "no session import"}`)
  return state.nativeForkDeclined ? `native fork declined, imported: ${state.nativeForkDeclined}` : "imported session"
}

async function steeredTurn(h, label) {
  const { id } = await h.conversation(label)
  const nonce = `steer-${randomUUID().slice(0, 8)}`
  const requestId = randomUUID()
  h.owner.submit(id, requestId, "Run exactly one foreground terminal command: sleep 15. Wait for it to finish, then reply with DONE.")
  await h.wait(id, "the turn to be running a tool", (snapshot) => h.toolsAfter(id, requestId).length > 0 || !ACTIVE.has(snapshot?.requests[0]?.status ?? "queued"), 120_000)
  if (!ACTIVE.has(h.request(id, requestId).status)) throw new Error("The turn ended before it could be steered")
  const action = randomUUID()
  await h.owner.act(id, { kind: "steer", id: action, requestId, text: `Also put the word ${nonce} in your final reply.`, attachments: [] })
  await h.wait(id, "the steered turn to end", (snapshot) => !ACTIVE.has(snapshot?.requests[0]?.status ?? "queued"))
  const receipt = h.snapshot(id).control?.actions?.find((entry) => entry.input?.id === action)
  if (!["accepted", "completed"].includes(receipt?.state.kind)) throw new Error(`The steer was ${receipt?.state.kind ?? "never recorded"}${receipt?.state.reason ? `: ${receipt.state.reason}` : ""}`)
  const steering = h.snapshot(id).blocks.filter((block) => block.type === "user" && block.steeringFor === requestId)
  if (steering.length !== 1) throw new Error(`The transcript shows ${steering.length} steering messages, not 1`)
  if (!h.reply(id, requestId).includes(nonce)) throw new Error("The final reply ignored the steer")
  return { id, requestId, nonce, receipt: receipt.state.kind }
}

// A flow runs when the harness's catalog entry is implemented; otherwise it is
// skipped with the driver's own reason, the words the window shows.
function declares(tools, driver, key) {
  const capability = tools.harnesses.get(driver.provider)?.capabilities[key]
  if (!capability) return `${key} is not in the catalog`
  if (capability.state === "implemented") return true
  return `${key} ${capability.state === "absent" ? `absent (${capability.by === "mako" ? "Mako gap" : "harness has none"})` : capability.state}: ${capability.reason}`
}

/** The same for a shared feature, which runs as the harness's own or Mako's. */
function features(tools, driver, key) {
  const standing = tools.harnesses.get(driver.provider)?.features[key]?.mako
  if (!standing) return `${key} is not among the harness's features`
  if (standing.state === "implemented") return true
  return `${key} ${standing.state}: ${standing.reason}`
}

/** A checkout with one uncommitted change to review: an average that divides by an empty list's length. */
async function plantBug(cwd) {
  const git = (...args) => execFileSync("git", ["-c", "user.email=flows@example.com", "-c", "user.name=Flows", ...args], { cwd, stdio: "ignore" })
  git("init", "-q")
  await writeFile(join(cwd, "average.js"), "export function average(values) {\n  if (values.length === 0) return 0\n  return values.reduce((sum, value) => sum + value, 0) / values.length\n}\n")
  git("add", ".")
  git("commit", "-qm", "Add average")
  await writeFile(join(cwd, "average.js"), "export function average(values) {\n  return values.reduce((sum, value) => sum + value, 0) / values.length\n}\n")
}

/** The main conversation: a remembered marker carried through a follow-up and a restart. */
const remember = {
  name: "first-turn", core: true, declared: () => true,
  async run(h) {
    h.marker = `flow-${randomUUID().slice(0, 8)}`
    h.main = await h.conversation("main")
    h.main.first = await h.completed(h.main.id, `Remember the marker ${h.marker}. Reply with only ACK. Do not use any tools.`)
    h.main.nativeId = h.snapshot(h.main.id).session.nativeId
    if (!h.main.nativeId) throw new Error("The harness reported no native session ID")
    return { nativeId: h.main.nativeId }
  },
}

const recall = (h, id, requestId) => {
  const reply = h.reply(id, requestId)
  if (!reply.includes(h.marker)) throw new Error(`The reply lost the remembered marker: ${JSON.stringify(reply.slice(0, 200))}`)
}

const FLOWS = [
  remember,
  {
    name: "follow-up", core: true, declared: () => true,
    async run(h) {
      const requestId = await h.completed(h.main.id, "What marker did I ask you to remember? Reply with only the marker. Do not use any tools.")
      recall(h, h.main.id, requestId)
      if (h.snapshot(h.main.id).session.nativeId !== h.main.nativeId) throw new Error("The follow-up moved to a different native session")
      return {}
    },
  },
  {
    name: "restart", core: true, declared: () => true,
    async run(h) {
      const { blocks: { length: before }, session: { currentMode: mode } } = h.snapshot(h.main.id)
      await h.host.restart()
      const reopened = h.snapshot(h.main.id)
      if (!reopened) throw new Error("The restarted host could not reopen the conversation")
      if (reopened.blocks.length < before) throw new Error(`The reopened transcript lost blocks: ${reopened.blocks.length} of ${before}`)
      const requestId = await h.completed(h.main.id, "After the restart: what marker did I ask you to remember? Reply with only the marker. Do not use any tools.")
      recall(h, h.main.id, requestId)
      const after = h.snapshot(h.main.id)
      if (after.session.nativeId !== h.main.nativeId) throw new Error("The restart resumed a different native session")
      if (after.session.currentMode !== mode) throw new Error(`The restart changed the mode from ${mode} to ${after.session.currentMode}`)
      const request = h.request(h.main.id, requestId)
      if (request.context?.some((manifest) => manifest.includesBase)) throw new Error("The restart replayed the transcript instead of resuming the native session")
      return { blocksKept: before }
    },
  },
  {
    name: "question",
    declared: (driver, tools) => declares(tools, driver, "questions"),
    async run(h) {
      const { id } = await h.conversation("question")
      const requestId = randomUUID()
      h.owner.submit(id, requestId, "Use your tool for asking the user a question, not plain text, to ask me exactly one multiple-choice question: \"Which colour?\" with the options Red and Blue. After I answer, reply with only the colour I chose.")
      const asked = h.pendingQuestion(await h.wait(id, "the harness to ask its question", (snapshot) => Boolean(h.pendingQuestion(snapshot)) || !ACTIVE.has(snapshot?.requests[0]?.status ?? "queued")))
      if (!asked) throw new Error(`The harness ended the turn without asking through its question tool: ${JSON.stringify(h.reply(id, requestId).slice(0, 200))}`)
      const blue = asked.question.options.find((option) => /blue/i.test(option.label))
      if (!blue) throw new Error(`The question had no Blue option: ${asked.question.options.map((option) => option.label).join(", ")}`)
      await h.owner.permission(id, asked.id, { kind: "answers", answers: { [asked.question.id]: [blue.label] } })
      await h.wait(id, "the answered turn to end", (snapshot) => !ACTIVE.has(snapshot?.requests[0]?.status ?? "queued"))
      if (h.request(id, requestId).status !== "completed") throw new Error(`The answered turn ended ${h.request(id, requestId).status}`)
      if (!/blue/i.test(h.reply(id, requestId))) throw new Error(`The reply did not use the answer: ${JSON.stringify(h.reply(id, requestId).slice(0, 200))}`)
      return { tool: h.toolsAfter(id, requestId).find((tool) => tool.kind === "question")?.name }
    },
  },
  {
    name: "plan",
    declared: (driver) => driver.planning ? true : "no planning declared",
    async run(h) {
      const { planning, defaultMode } = h.driver
      const marker = `plan-${randomUUID().slice(0, 8)}`
      const { id, cwd } = await h.conversation("plan", planStart(h))
      const tuning = (plan) => planning.via === "setting" ? { ...h.snapshot(id).session.settings, options: { ...h.snapshot(id).session.settings?.options, [planning.option]: plan } } : undefined
      const file = join(cwd, "plan-proof.txt")
      const planRequest = await h.send(id, `Plan creating a file named plan-proof.txt in the current folder containing exactly ${marker}. The plan is one step; ask me nothing. Once I approve the plan, create the file.`, {
        tuning: tuning(true),
        until: (snapshot) => snapshot?.permissions.some((permission) => permission.implementsPlan),
      })
      const proposed = h.snapshot(id).blocks.find((block) => block.type === "proposed-plan")
      if (!proposed) throw new Error("No proposed plan reached the transcript")
      if (existsSync(file)) throw new Error("The harness created the file while planning")
      const approval = h.snapshot(id).permissions.find((permission) => permission.implementsPlan)
      if (approval) {
        await h.owner.permission(id, approval.id, { kind: "choice", optionId: approval.implementsPlan.approve })
        await h.wait(id, "the approved plan to be built", (snapshot) => !ACTIVE.has(snapshot?.requests.find((request) => request.id === planRequest)?.status ?? "queued"))
      } else {
        if (planning.via === "mode") await h.owner.setMode(id, h.fullMode ?? defaultMode)
        await h.completed(id, "Implement the plan.", { tuning: tuning(false) })
      }
      const written = await readFile(file, "utf8").catch(() => undefined)
      if (written?.trim() !== marker) throw new Error(`The plan was not built: plan-proof.txt is ${written === undefined ? "missing" : JSON.stringify(written.slice(0, 80))}`)
      return { approvedInPlace: Boolean(approval), planChars: proposed.text.length }
    },
  },
  {
    // The harness's own goal where it has one, Mako's loop where it doesn't: either way the goal ends complete, with its work done.
    name: "goal",
    declared: (driver, tools) => features(tools, driver, "goals"),
    async run(h) {
      const marker = `goal-${randomUUID().slice(0, 8)}`
      const { id, cwd } = await h.conversation("goal")
      await h.owner.goal(id, { kind: "set", objective: `A file named goal-proof.txt in the current folder containing exactly ${marker}. Ask me nothing.` })
      const idle = (snapshot) => snapshot?.session.status !== "running" && !snapshot?.requests.some((request) => ACTIVE.has(request.status))
      const { goal } = await h.wait(id, "the goal to finish", (snapshot) => !snapshot?.goal || (!snapshot.goal.pending && snapshot.goal.status !== "active" && idle(snapshot)))
      if (!goal) throw new Error("The goal disappeared before it finished")
      if (goal.status !== "complete") throw new Error(`The goal ended ${goal.status}${goal.note ? `: ${goal.note}` : ""}`)
      const written = await readFile(join(cwd, "goal-proof.txt"), "utf8").catch(() => undefined)
      if (written?.trim() !== marker) throw new Error(`The goal reported complete without its work: goal-proof.txt is ${written === undefined ? "missing" : JSON.stringify(written.slice(0, 80))}`)
      await h.owner.goal(id, { kind: "clear" })
      await h.wait(id, "the goal to clear", (snapshot) => !snapshot?.goal && idle(snapshot), 120_000)
      return { by: goal.by, turns: goal.turns, tokensUsed: goal.tokensUsed, seconds: goal.seconds }
    },
  },
  {
    // Asked while a turn runs, answered from the conversation, followed up on, and kept out of it.
    name: "side",
    declared: (driver, tools) => features(tools, driver, "sideQuestions"),
    async run(h) {
      const marker = `side-${randomUUID().slice(0, 8)}`
      const { id } = await h.conversation("side")
      await h.completed(id, `Remember the marker ${marker}. Reply with only ACK. Do not use any tools.`)
      const requestId = randomUUID()
      h.owner.submit(id, requestId, "Run exactly one foreground terminal command: sleep 15. Wait for it to finish, then reply with DONE.")
      await h.wait(id, "the turn to start", (snapshot) => ACTIVE.has(snapshot?.requests.find((entry) => entry.id === requestId)?.status ?? "queued") && snapshot.session.status === "running", 120_000)
      const asked = Date.now()
      const codename = `aside-${randomUUID().slice(0, 6)}`
      const first = `My side codename is ${codename}. What marker did I ask you to remember? Reply with only the marker.`
      await h.owner.sideQuestion(id, { kind: "ask", question: first })
      const answered = (index) => (snapshot) => ["answered", "failed", "stopped"].includes(snapshot?.side?.exchanges[index]?.status)
      const one = (await h.wait(id, "the side answer", answered(0), 180_000)).side.exchanges[0]
      if (one.status !== "answered") throw new Error(`The side question ended ${one.status}${one.error ? `: ${one.error}` : ""}`)
      if (!one.answer.includes(marker)) throw new Error(`The side answer lost the conversation's marker: ${JSON.stringify(one.answer.slice(0, 200))}`)
      const duringTurn = ACTIVE.has(h.request(id, requestId).status)
      const by = h.snapshot(id).side.by
      await h.owner.sideQuestion(id, { kind: "ask", question: "What side codename did I give you? Reply with only the codename." })
      const two = (await h.wait(id, "the follow-up side answer", answered(1), 180_000)).side.exchanges[1]
      if (two.status !== "answered") throw new Error(`The follow-up ended ${two.status}${two.error ? `: ${two.error}` : ""}`)
      if (!two.answer.includes(codename)) throw new Error(`The follow-up lost the side question before it: ${JSON.stringify(two.answer.slice(0, 200))}`)
      await h.wait(id, "the turn to end", (snapshot) => !ACTIVE.has(snapshot?.requests.find((entry) => entry.id === requestId)?.status ?? "queued"))
      const turn = h.request(id, requestId)
      if (turn.status !== "completed") throw new Error(`The turn the side question ran beside ended ${turn.status}`)
      const transcript = JSON.stringify(h.snapshot(id).blocks)
      if (transcript.includes(codename))
        throw new Error("A side question joined the conversation's transcript")
      await h.owner.sideQuestion(id, { kind: "ask", question: "Count slowly from 1 to 40, one number per line." })
      await h.owner.sideQuestion(id, { kind: "stop" })
      const stopped = (await h.wait(id, "the stopped side answer", answered(2), 5_000)).side.exchanges[2]
      if (stopped.status !== "stopped") throw new Error(`Stop left the side answer ${stopped.status}`)
      await h.owner.sideQuestion(id, { kind: "close" })
      if (h.snapshot(id).side) throw new Error("The side conversation stayed open after closing")
      if (by === "fork") await sideCopiesGone(h.provider, new Date(asked - 60_000).toISOString())
      return { by, duringTurn, seconds: Math.round((Date.now() - asked) / 1000) }
    },
  },
  {
    // The harness's own review where it has one, Mako's prompt where it doesn't: either way it finds the planted bug and changes nothing.
    name: "review",
    declared: (driver, tools) => features(tools, driver, "review"),
    async run(h) {
      const { id, cwd } = await h.conversation("review", {}, plantBug)
      const planted = await readFile(join(cwd, "average.js"), "utf8")
      const started = Date.now()
      const requestId = (await h.owner.review(id, { kind: "changes" })).requests.at(-1).id
      await h.wait(id, "the review to end", (snapshot) => !ACTIVE.has(snapshot?.requests.find((entry) => entry.id === requestId)?.status ?? "queued"), 600_000)
      if (h.request(id, requestId).status !== "completed") throw new Error(`The review ended ${h.request(id, requestId).status}`)
      if (await readFile(join(cwd, "average.js"), "utf8") !== planted) throw new Error("The review changed the file it reviewed")
      const blocks = h.snapshot(id).blocks
      const start = blocks.findIndex((block) => block.type === "user" && block.requestId === requestId)
      const reported = blocks.slice(start + 1).flatMap((block) => block.type === "tool" ? (block.details ?? []) : []).filter((detail) => detail.type === "review").at(-1)
      const reply = h.reply(id, requestId)
      const fenced = new RegExp(`\`\`\`${REVIEW_FENCE}\\s*\\n([\\s\\S]*?)\`\`\``).exec(reply)?.[1]
      const report = reported ?? (fenced ? makoReviewReport(fenced) : undefined)
      const found = report ? report.findings.some((finding) => /average/.test(finding.path ?? "") && /empty|zero|length|NaN|divi/i.test(`${finding.title} ${finding.body ?? ""}`)) : /average\.js/.test(reply) && /empty|zero|NaN|divi/i.test(reply)
      if (!found) throw new Error(`The review missed the planted bug: ${JSON.stringify((report ? JSON.stringify(report) : reply).slice(0, 400))}`)
      return { via: reported ? "harness" : fenced ? "mako-review block" : "prose", findings: report?.findings.length, seconds: Math.round((Date.now() - started) / 1000) }
    },
  },
  {
    name: "steer",
    declared: (driver, tools) => declares(tools, driver, "steering"),
    async run(h) {
      const { receipt } = await steeredTurn(h, "steer")
      return { receipt }
    },
  },
  {
    // A message sent into a turn is part of it, so a native fork after the turn keeps it.
    name: "steered-fork",
    declared: (driver, tools) => {
      const steering = declares(tools, driver, "steering")
      if (steering !== true) return steering
      return driver.fork.kind === "native" ? declares(tools, driver, "fork") : "the harness does not fork natively"
    },
    async run(h) {
      const steered = await steeredTurn(h, "steered-fork")
      const forkId = randomUUID()
      h.owner.fork(steered.id, { id: forkId, provider: h.provider, point: { kind: "run", requestId: steered.requestId } })
      h.open.add(forkId)
      const requestId = await h.completed(forkId, "What word did I ask you to put in your final reply? Reply with only that word. Do not use any tools.")
      if (!h.reply(forkId, requestId).includes(steered.nonce)) throw new Error("The fork lost the message sent into the turn it forked after")
      const way = forkWay(h.snapshot(forkId))
      if (way === "imported session") throw new Error("The fork after a steered turn was not native")
      return { native: way }
    },
  },
  {
    name: "interrupt", declared: () => true,
    async run(h) {
      const { id } = await h.conversation("interrupt")
      const requestId = randomUUID()
      h.owner.submit(id, requestId, "Run exactly one foreground terminal command: sleep 90. Wait for it, then reply with DONE.")
      await h.wait(id, "the turn to be running a tool", (snapshot) => h.toolsAfter(id, requestId).length > 0 || !ACTIVE.has(snapshot?.requests[0]?.status ?? "queued"), 120_000)
      if (!await h.owner.stopRequest(id, requestId)) throw new Error("Stop found no running turn")
      await h.wait(id, "the stopped turn to settle", (snapshot) => !ACTIVE.has(snapshot?.requests[0]?.status ?? "queued"), 30_000)
      if (h.request(id, requestId).status !== "interrupted") throw new Error(`The stopped turn ended ${h.request(id, requestId).status}`)
      const next = await h.completed(id, "Reply with only OK. Do not use any tools.")
      if (!/ok/i.test(h.reply(id, next))) throw new Error("The session did not answer after Stop")
      return {}
    },
  },
  {
    // A host that dies mid-turn leaves its provider processes to die with it
    // or to the next host's reaper. Either way the native session may still
    // say a turn is running; after a restart it must take a message again.
    name: "killed-turn", declared: () => true,
    async run(h) {
      const { id } = await h.conversation("killed")
      const requestId = randomUUID()
      h.owner.submit(id, requestId, "Run exactly one foreground terminal command: sleep 90. Wait for it, then reply with DONE.")
      await h.wait(id, "the turn to be running a tool", (snapshot) => h.toolsAfter(id, requestId).length > 0 || !ACTIVE.has(snapshot?.requests[0]?.status ?? "queued"), 120_000)
      if (!ACTIVE.has(h.request(id, requestId).status)) throw new Error("The turn ended before its process could be killed")
      const pids = await providerPids(h.root, id)
      if (!pids.length) throw new Error("This host recorded no provider process for the conversation")
      for (const pid of pids) process.kill(pid, "SIGKILL")
      await h.wait(id, "the killed turn to settle", (snapshot) => !ACTIVE.has(snapshot?.requests[0]?.status ?? "queued"), 60_000)
      const killedTurn = h.request(id, requestId).status
      await h.host.restart()
      const next = await h.completed(id, "Reply with only OK. Do not use any tools.")
      if (!/ok/i.test(h.reply(id, next))) throw new Error("The conversation did not answer after its process was killed")
      const log = await readFile(join(h.root, "host.log"), "utf8").catch(() => "")
      return { killed: pids.length, killedTurn, expiredNativeRun: log.includes("expiring the run a child that is gone left active") }
    },
  },
  {
    name: "fork", declared: (driver, tools) => declares(tools, driver, "fork"),
    async run(h) {
      const forkId = randomUUID()
      h.owner.fork(h.main.id, { id: forkId, provider: h.provider, point: { kind: "run", requestId: h.main.first } })
      h.open.add(forkId)
      h.current = forkId
      const requestId = await h.completed(forkId, "What marker did I ask you to remember earlier in this conversation? Reply with only the marker. Do not use any tools.")
      recall(h, forkId, requestId)
      const forked = h.snapshot(forkId)
      if (forked.session.nativeId === h.main.nativeId) throw new Error("The fork wrote into the original native session")
      if (h.snapshot(h.main.id).session.nativeId !== h.main.nativeId) throw new Error("Forking moved the original conversation")
      const parentMode = h.snapshot(h.main.id).session.currentMode
      if (parentMode && forked.session.currentMode !== parentMode) throw new Error(`The fork opened in ${forked.session.currentMode}, not the parent's ${parentMode}`)
      return { native: forkWay(forked) }
    },
  },
  {
    // A fork can go natively and skip the import a move from another harness depends on.
    name: "import",
    declared: (driver, tools) => !tools.emitters.get(driver.provider) ? "no session import"
      : tools.readable.includes(driver.provider) ? true : "Mako reads none of its saved sessions, so none can be opened",
    async run(h) {
      const { ms, path, codename } = await resumeImported(h, h.tools.emitters.get(h.provider), "import", 2)
      const page = await h.tools.history(path)
      if (!page?.entries.some((entry) => entry.type === "user" && entry.text.includes(codename))) throw new Error("Mako's catalog did not read the imported session back")
      return { ms }
    },
  },
  {
    name: "compaction",
    declared: (driver, tools) => declares(tools, driver, "compaction"),
    async run(h) {
      const action = randomUUID()
      const before = h.snapshot(h.main.id).session.usage
      await h.owner.act(h.main.id, { kind: "compact", id: action })
      await h.wait(h.main.id, "compaction to finish", (snapshot) => ["completed", "failed", "refused"].includes(snapshot?.control?.actions?.find((entry) => entry.input?.id === action)?.state.kind))
      const receipt = h.snapshot(h.main.id).control.actions.find((entry) => entry.input?.id === action)
      if (receipt.state.kind !== "completed") throw new Error(`Compaction ${receipt.state.kind}: ${receipt.state.error ?? ""}`)
      // What the meter reads between the compaction and the next reply is what its usage declaration says.
      const after = h.snapshot(h.main.id).session.usage
      const declared = h.tools.harnesses.get(h.provider)?.usage?.compaction?.state
      if (declared === "implemented" && before?.used !== undefined && after?.used === undefined)
        throw new Error(`Declares that a compaction says what it left, yet the meter reads nothing after it: ${JSON.stringify(after)}`)
      if (declared === "default" && after?.used !== undefined)
        throw new Error(`Declares that a compaction says nothing of what it left, yet the meter reads ${after.used} after it (was ${before?.used})`)
      await h.completed(h.main.id, "Reply with only OK. Do not use any tools.")
      const next = h.snapshot(h.main.id).session.usage
      return { meter: { declared, before: before?.used ?? null, after: after?.used ?? null, compactedFrom: after?.compactedFrom ?? null, next: next?.used ?? null, size: next?.size ?? null } }
    },
  },
  {
    name: "image", declared: () => true,
    async run(h) {
      const { id } = await h.conversation("image")
      const data = imageFixture()
      const requestId = await h.completed(id, "How many red squares and how many blue squares are in the image? Reply exactly as: red N, blue M. Do not use any tools.", {
        attachments: [{ name: "squares.png", mimeType: "image/png", size: data.length, data: data.toString("base64") }],
      })
      if (!/red\D*4/i.test(h.reply(id, requestId)) || !/blue\D*2/i.test(h.reply(id, requestId))) throw new Error(`The reply misread the image: ${JSON.stringify(h.reply(id, requestId).slice(0, 120))}`)
      return {}
    },
  },
  {
    name: "subagent",
    declared: (driver, tools) => declares(tools, driver, "nativeAgents"),
    async run(h) {
      const { id } = await h.conversation("subagent")
      const nonce = `agent-${randomUUID().slice(0, 8)}`
      const requestId = await h.completed(id, `Use your subagent tool to start exactly one subagent whose only job is to reply with the word ${nonce}, without using tools. Then reply with what it returned.`)
      const agent = h.toolsAfter(id, requestId).find((tool) => tool.kind === "agent")
      if (!agent) throw new Error(`No subagent tool call in the transcript: ${JSON.stringify(h.toolsAfter(id, requestId))}`)
      if (!h.reply(id, requestId).includes(nonce)) throw new Error("The reply lost what the subagent returned")
      return { tool: agent.name, roster: h.snapshot(id).nativeAgents?.agents.length ?? 0, spent: h.request(id, requestId).spend?.tokens }
    },
  },
  {
    // The Agents panel's Stop on one entry ends that work alone; Stop ends the rest.
    name: "background-stop",
    declared: (driver) => driver.stopNativeAgent ? true : "the harness can't stop one background task alone",
    async run(h) {
      const { id } = await h.conversation("background-stop")
      const running = () => (h.snapshot(id).nativeAgents?.agents ?? []).filter((agent) => agent.background && agent.stoppable && agent.state.kind === "working")
      await h.completed(id, "Start two shell commands in the background with your shell tool's background option, one call each: `sleep 300` and `sleep 301`. Don't wait for them. Then reply with only STARTED.")
      await h.wait(id, "two stoppable background commands", () => running().length >= 2, 60_000)
      const [stopped, kept] = running()
      if (!await h.owner.stopNativeAgent(id, stopped.nativeId)) throw new Error("Stop on one entry found nothing to stop")
      const entry = (nativeId) => h.snapshot(id).nativeAgents?.agents.find((agent) => agent.nativeId === nativeId)
      await h.wait(id, "the stopped command to end", () => entry(stopped.nativeId)?.state.kind !== "working", 30_000)
      if (entry(kept.nativeId)?.state.kind !== "working") throw new Error(`Stopping one entry ended the other: ${entry(kept.nativeId)?.state.kind}`)
      await h.owner.cancel(id)
      await h.wait(id, "Stop to end the other command", () => entry(kept.nativeId)?.state.kind !== "working", 30_000)
      return { stopped: entry(stopped.nativeId).state.kind, rest: entry(kept.nativeId).state.kind }
    },
  },
  {
    // Where a harness reads `.agents/skills`, Mako sends a skill there by name
    // instead of inlining it; in a folder whose project skills it won't load,
    // Mako hands the skill over, and the harness must indeed not have it.
    name: "universal-skill",
    declared: (driver, tools) => tools.skills.get(driver.provider)?.readsUniversalRoot ? true : "its skill source doesn't claim .agents/skills",
    async run(h) {
      const name = `mako-flow-${randomUUID().slice(0, 8)}`
      const code = `code-${randomUUID().slice(0, 8)}`
      const { id, cwd } = await h.conversation("universal-skill", {}, async (cwd) => {
        const dir = join(cwd, ".agents", "skills", name)
        await mkdir(join(cwd, ".git"), { recursive: true })
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Says the code ${code}.\n---\nReply with the code ${code}.\n`)
      })
      const loads = h.tools.skills.get(h.provider)?.readsWorkspace?.(cwd) ?? true
      const requestId = await h.completed(id, `Is a skill named ${name} available to you? If it is, reply with only the code its description gives; if it isn't, reply with only NONE. Do not read any files or run commands.`)
      const tools = h.snapshot(id).blocks.filter((block) => block.type === "tool").map((block) => block.name ?? block.title)
      const reads = tools.filter((tool) => !/skill/i.test(tool))
      if (reads.length) throw new Error(`The harness looked for the skill itself instead of having it: ${reads.join(", ")}`)
      const reply = h.reply(id, requestId)
      if (loads && !reply.includes(code)) throw new Error(`The harness doesn't have the skill from .agents/skills: ${JSON.stringify(reply.slice(0, 200))}`)
      if (!loads && reply.includes(code)) throw new Error("The harness loaded a project skill Mako says it skips in this folder, so Mako hands over what it already has")
      return { skillTools: tools, loadsProjectSkills: loads }
    },
  },
  {
    // Cursor's agents read their past chats from this file. Mako's SDK patch
    // appends to it once it holds 16 messages; a new child rewrites it whole,
    // as the SDK always did, so the rewrite must reproduce every appended line.
    name: "native-transcript",
    declared: (driver) => driver.provider === "cursor" ? true : "only the Cursor SDK writes a transcript Mako's patch appends to",
    async run(h) {
      const { id, cwd } = await h.conversation("transcript")
      const commands = Array.from({ length: 8 }, (_, index) => `echo t${index + 1}`).join(", ")
      await h.completed(id, `Run these shell commands one at a time, each as its own tool call, in this order: ${commands}. Then reply with only DONE.`)
      const path = await cursorTranscript(cwd, h.snapshot(id).session.nativeId)
      const first = await settledTranscript(path)
      // A line of the test's own: an append leaves it where it is, a full rewrite drops it.
      await appendFile(path, `${PROBE}\n`)
      await h.completed(id, "Reply with only OK.")
      const appended = await settledTranscript(path)
      if (!appended.probed) throw new Error(`The second turn rewrote the transcript instead of appending to it (${first.lines.length} messages before it)`)
      if (appended.lines.length <= first.lines.length) throw new Error("The second turn is missing from the transcript")
      await h.host.restart()
      await h.completed(id, "Reply with only OK again.")
      const rewritten = await settledTranscript(path)
      if (rewritten.probed) throw new Error("The new child appended instead of rewriting its first write")
      const prefix = rewritten.lines.slice(0, appended.lines.length)
      const differs = prefix.findIndex((line, index) => line !== appended.lines[index])
      if (differs >= 0 || prefix.length < appended.lines.length) throw new Error(`The full rewrite differs from the appended transcript at message ${differs >= 0 ? differs : prefix.length} of ${appended.lines.length}`)
      if (rewritten.lines.length <= appended.lines.length) throw new Error("The turn after the restart is missing from the transcript")
      return { firstTurnMessages: first.lines.length, appendedMessages: appended.lines.length, rewrittenMessages: rewritten.lines.length }
    },
  },
]

/** The provider processes this host spawned for one conversation, from the registry the next host reaps. */
async function providerPids(root, conversationId) {
  const registry = JSON.parse(await readFile(join(root, "profile", "runtime", "provider-children.json"), "utf8").catch(() => '{"children":[]}'))
  return registry.children.filter((child) => child.owner === conversationId).map((child) => child.pid)
}

/** The Cursor SDK's transcript for `agentId`, in the project folder it names after `cwd`. */
async function cursorTranscript(cwd, agentId) {
  const projects = join(homedir(), ".cursor", "projects")
  const name = basename(cwd)
  for (const project of (await readdir(projects)).filter((entry) => entry.endsWith(name))) {
    const folder = join(projects, project, "agent-transcripts")
    const found = (await readdir(folder, { recursive: true }).catch(() => [])).find((entry) => basename(entry) === `${agentId}.jsonl`)
    if (found) return join(folder, found)
  }
  throw new Error(`No Cursor transcript for ${agentId} under a project named for ${name}`)
}

const PROBE = JSON.stringify({ type: "mako_flow_probe" })

/** The transcript once it has not changed for a second: the SDK writes it after the turn ends. */
async function settledTranscript(path) {
  let text = await readFile(path, "utf8")
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    await delay(1_000)
    const next = await readFile(path, "utf8")
    if (next === text) break
    text = next
  }
  return transcriptLines(text)
}

/** A transcript's messages, without the turn-ended lines a full write keeps only the latest of, and whether the probe is in it. */
function transcriptLines(text) {
  const all = text.split("\n").filter(Boolean)
  return { lines: all.filter((line) => line !== PROBE && !line.startsWith('{"type":"turn_ended"')), probed: all.includes(PROBE) }
}

/** Sessions left in each state a person can walk away from, for `--continue` on the next build. */
const RECORDED = [
  { ...remember, async run(h) {
    const evidence = await remember.run(h)
    h.recorded.push({ kind: "idle", harness: h.provider, id: h.main.id, marker: h.marker, nativeId: h.main.nativeId })
    return evidence
  } },
  {
    name: "question-pending", declared: FLOWS.find((flow) => flow.name === "question").declared,
    async run(h) {
      const { id } = await h.conversation("question-pending")
      h.owner.submit(id, randomUUID(), "Use your tool for asking the user a question, not plain text, to ask me exactly one multiple-choice question: \"Which colour?\" with the options Red and Blue. After I answer, reply with only the colour I chose.")
      const asked = h.pendingQuestion(await h.wait(id, "the harness to ask its question", (snapshot) => Boolean(h.pendingQuestion(snapshot)) || !ACTIVE.has(snapshot?.requests[0]?.status ?? "queued")))
      if (!asked) throw new Error("The harness ended the turn without asking")
      h.recorded.push({ kind: "question", harness: h.provider, id, nativeId: h.snapshot(id).session.nativeId })
      return {}
    },
  },
  {
    // Opened from a session the harness wrote, so the build that recorded it keeps a copy of that history in the journal.
    name: "imported", declared: FLOWS.find((flow) => flow.name === "import").declared,
    async run(h) {
      const { id, codename } = await resumeImported(h, h.tools.emitters.get(h.provider), "imported", 2)
      h.recorded.push({ kind: "imported", harness: h.provider, id, marker: codename, nativeId: h.snapshot(id).session.nativeId })
      return {}
    },
  },
  {
    name: "plan-proposed", declared: FLOWS.find((flow) => flow.name === "plan").declared,
    async run(h) {
      const { planning } = h.driver
      const marker = `plan-${randomUUID().slice(0, 8)}`
      const { id, cwd } = await h.conversation("plan-proposed", planStart(h))
      const settings = h.snapshot(id).session.settings
      await h.send(id, `Plan creating a file named plan-proof.txt in the current folder containing exactly ${marker}. The plan is one step; ask me nothing. Once I approve the plan, create the file.`, {
        tuning: planning.via === "setting" ? { ...settings, options: { ...settings?.options, [planning.option]: true } } : undefined,
        until: (snapshot) => snapshot?.permissions.some((permission) => permission.implementsPlan),
      })
      if (!h.snapshot(id).blocks.some((block) => block.type === "proposed-plan")) throw new Error("No proposed plan reached the transcript")
      h.recorded.push({ kind: "plan", harness: h.provider, id, cwd, marker, nativeId: h.snapshot(id).session.nativeId })
      return {}
    },
  },
]

/** The next build, picking up every recorded conversation where the person left it. */
async function continueRecorded(root, host, providerHost, tools, results, report, { copiedBaseBytes }) {
  const { conversations } = JSON.parse(await readFile(join(root, "recorded.json"), "utf8"))
  // What the app's idle sweep does a minute after this build starts: copies whose session the record store can hold go.
  const journals = join(root, "conversations")
  const copies = new Map(conversations.map((entry) => [entry.id, copiedBaseBytes(journals, entry.id)]))
  const settled = await host.owner.settleHistoryCopies(0)
  console.log(`Sweep: ${settled.copies} copies, ${settled.moved} moved onto their sessions' records${settled.journals.filter((journal) => journal.keptBecause).map((journal) => `; ${journal.id.slice(0, 8)} kept: ${journal.keptBecause}`).join("")}`)
  const swept = new Map(conversations.map((entry) => [entry.id, copiedBaseBytes(journals, entry.id)]))
  for (const journal of settled.journals)
    if (!journal.keptBecause && swept.get(journal.id))
      throw new Error(`The sweep moved ${journal.id}'s copy, but its journal still keeps ${swept.get(journal.id)} bytes of it`)
  for (const entry of conversations) {
    const h = new Harness(providerHost.liveDrivers.get(entry.harness), host, root, tools)
    h.current = entry.id
    h.marker = entry.marker
    const began = Date.now()
    try {
      const reopened = h.snapshot(entry.id)
      if (!reopened) throw new Error("This build could not reopen the recorded conversation")
      if (entry.kind === "idle") {
        const requestId = await h.completed(entry.id, "What marker did I ask you to remember? Reply with only the marker. Do not use any tools.")
        recall(h, entry.id, requestId)
        if (h.snapshot(entry.id).session.nativeId !== entry.nativeId) throw new Error("The new build resumed a different native session")
      } else if (entry.kind === "imported") {
        const requestId = await h.completed(entry.id, "What codename did I give in my first message? Reply with only the codename. Do not use any tools.")
        if (!h.reply(entry.id, requestId).includes(entry.marker)) throw new Error(`The imported history was lost: ${JSON.stringify(h.reply(entry.id, requestId).slice(0, 80))}`)
        const kept = settled.journals.find((journal) => journal.id === entry.id)?.keptBecause
        console.log(`${entry.harness} imported ${entry.id.slice(0, 8)}: copy ${copies.get(entry.id)} bytes before the sweep, ${swept.get(entry.id)} after it, ${copiedBaseBytes(journals, entry.id)} once a turn ran past what its session record covered${kept ? ` (kept: ${kept})` : ""}`)
      } else if (entry.kind === "question") {
        const asked = h.pendingQuestion(reopened)
        if (asked) {
          const blue = asked.question.options.find((option) => /blue/i.test(option.label)) ?? asked.question.options[0]
          await h.owner.permission(entry.id, asked.id, { kind: "answers", answers: { [asked.question.id]: [blue.label] } })
          await h.wait(entry.id, "the answer to land", (snapshot) => !h.pendingQuestion(snapshot) && !snapshot.requests.some((request) => ACTIVE.has(request.status)))
        }
        await h.completed(entry.id, "Reply with only OK. Do not use any tools.")
      } else if (entry.kind === "plan") {
        const approval = reopened.permissions.find((permission) => permission.implementsPlan)
        if (approval) {
          await h.owner.permission(entry.id, approval.id, { kind: "choice", optionId: approval.implementsPlan.approve })
          await h.wait(entry.id, "the approved plan to be built", (snapshot) => !snapshot.requests.some((request) => ACTIVE.has(request.status)))
        }
        if (!existsSync(join(entry.cwd, "plan-proof.txt"))) {
          const { planning, defaultMode } = h.driver
          if (planning.via === "mode") await h.owner.setMode(entry.id, h.fullMode ?? defaultMode)
          const settings = h.snapshot(entry.id).session.settings
          await h.completed(entry.id, "Implement the plan.", { tuning: planning.via === "setting" ? { ...settings, options: { ...settings?.options, [planning.option]: false } } : undefined })
        }
        const written = await readFile(join(entry.cwd, "plan-proof.txt"), "utf8").catch(() => undefined)
        if (written?.trim() !== entry.marker) throw new Error(`The recorded plan was not built: plan-proof.txt is ${written === undefined ? "missing" : JSON.stringify(written.slice(0, 80))}`)
      }
      results.push({ harness: entry.harness, flow: `continue-${entry.kind}`, result: "passed", ms: Date.now() - began })
    } catch (error) {
      results.push({ harness: entry.harness, flow: `continue-${entry.kind}`, result: "failed", ms: Date.now() - began, reason: error.message, state: h.describe() })
    }
    await host.owner.close(entry.id).catch(() => {})
    console.log(JSON.stringify(results.at(-1)))
    await report()
  }
}

/** How a session starts for planning: in the plan mode, beside the access level a launch-only harness needs. */
function planStart(h) {
  const { planning, defaultMode } = h.driver
  if (planning.via !== "mode") return {}
  const start = { modeId: planning.mode }
  if (defaultMode) start.launchModeId = h.fullMode ?? defaultMode
  return start
}

function brief(block) {
  if (block.type === "text") return { type: block.type, text: block.text.slice(0, 160) }
  if (block.type === "tool") return { type: block.type, name: block.name, status: block.status }
  return { type: block.type }
}

function withDeadline(work, ms, message) {
  let timer
  return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]).finally(() => clearTimeout(timer))
}
