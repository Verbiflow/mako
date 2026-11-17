import "./lib/scratch-git.mjs"
/**
 * Where a harness waits for Mako before each of its agent's tools (`ProviderLiveDriver.firstWrite`), a turn's
 * message goes at once and its first write waits for the turn's checkpoint instead (`WriteHolds`):
 * - the provider has the message while the "before" capture still reads the workspace;
 * - a write asked for then waits until the capture holds the workspace, so rewinding to "before" undoes it;
 * - when the wait runs out, the write goes and the late capture is never the turn's "before";
 * - Claude's PreToolUse hook waits for a tool that may write, never for one that only reads.
 */
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import { CallBounds } from "@mako/host/harnesses/call-bounds"
import { claudeCallHooks } from "@mako/host/harnesses/claude/call-hooks"
import { WriteHolds } from "@mako/host/harnesses/write-holds"
import { personCodeRuns } from "@mako/host/harnesses/claude/person-hooks"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const gitRunner = new Git()
const root = mkdtempSync(join(tmpdir(), "mako-first-write-"))
const cwd = join(root, "workspace")
mkdirSync(cwd)
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
git("init", "-q")
git("config", "user.name", "Test")
git("config", "user.email", "test@localhost")
const file = join(cwd, "answer")
writeFileSync(file, "initial")
git("add", ".")
git("commit", "-qm", "initial")
const snapshots = new WorkspaceSnapshots(gitRunner, join(root, "snapshots"))
const captures = new Set<Promise<unknown>>()
function tracked<T>(pending: Promise<T>): Promise<T> {
  captures.add(pending)
  void pending.then(() => captures.delete(pending), () => captures.delete(pending))
  return pending
}
const end = snapshots.endRun.bind(snapshots)
mock.method(snapshots, "endRun", (...args: Parameters<WorkspaceSnapshots["endRun"]>) => tracked(end(...args)))

const holds = new WriteHolds()
/** Whether the fixture's next launch says its writes are held (`WriteHolds.attend`). */
let attended = true
const states = new Map<string, LiveSessionState>()
const sent: string[] = []
const steered: string[] = []
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  steering: { kind: "supported", lands: "interrupt", landing: "native", via: "Injected driver fixture", steer: async (_id, input) => {
    steered.push(input.text)
    return { kind: "accepted" }
  } },
  resume: fixtureResume(),
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
  firstWrite: { via: "Injected driver fixture: its agent asks `WriteHolds` before writing" },
  provider: "test",
  available: () => true,
  async start(directory, options) {
    const state: LiveSessionState = {
      id: options.conversationId,
      nativePath: options.resume ? options.threadPath : undefined,
      harness: "test",
      cwd: directory,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    }
    states.set(state.id, state)
    // As Claude's driver does when nothing the person set up runs beside its hook (`personCodeRuns`).
    holds.attend(options.conversationId, attended)
    return state
  },
  async prompt(id, text, _attachments, _settings, dispatch) {
    dispatch.report({ kind: "submitted", source: "transport-call" })
    const state = states.get(id)
    assert.ok(state)
    sent.push(text)
    const running: LiveSessionState = { ...state, status: "running", nativeRunId: randomUUID() }
    states.set(id, running)
    owner.observe({ type: "live-session", session: running })
  },
  permission: async () => {},
  cancel: async () => {},
  setMode: async () => {},
  close: () => {},
}
const dependencies = {
  root: join(root, "conversations"),
  appPath: root,
  workspaceSnapshots: snapshots,
  writeHolds: holds,
  checkpointWaitMs: 200,
  driver: () => driver,
  history: async () => null,
  emit: () => {},
}
let owner = new LiveConversations(dependencies)

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for run/checkpoint")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
function finish(id: string, answer: string) {
  const state = states.get(id)
  assert.ok(state)
  owner.observe({ type: "live-update", id, update: { kind: "text", text: answer } })
  const ready: LiveSessionState = { ...state, status: "ready" }
  states.set(id, ready)
  owner.observe({ type: "live-session", session: ready })
}
/** Whether `pending` settles within `ms`. */
async function settlesWithin(pending: Promise<unknown> | undefined, ms: number): Promise<boolean> {
  if (!pending) return true
  return Promise.race([pending.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))])
}
/** What the conversation's active binding is: the id its driver was started for, which writes are held by. */
function bindingOf(id: string): string {
  const binding = owner.snapshot(id)?.control?.activeBindingId
  assert.ok(binding)
  return binding
}
/** Takes the checkpoint's deadline from the clock: it fires only when the test says so, never under load. */
function holdDeadline() {
  let expire: (() => void) | undefined
  const schedule = globalThis.setTimeout
  const timer = mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    if (ms !== 200) return schedule(callback, ms, ...args)
    expire = () => callback(...args)
    return schedule(() => {}, 60_000).unref()
  })
  return { armed: () => expire !== undefined, expire: () => expire?.(), restore: () => timer.mock.restore() }
}
/** Holds the next `beginRun` before it reads anything, until released. */
function holdCapture() {
  const release = Promise.withResolvers<void>()
  let reading = false
  const original = snapshots.beginRun.bind(snapshots)
  const beginRun = mock.method(snapshots, "beginRun", (id: string, folder: string, frozen?: () => void) => {
    reading = true
    return tracked((async () => {
      await release.promise
      return original(id, folder, frozen)
    })())
  })
  return { release: () => release.resolve(), reading: () => reading, restore: () => beginRun.mock.restore() }
}

try {
  // The message goes while the capture is held; the agent's write waits for it, and a rewind to before undoes it.
  {
    const id = randomUUID(), request = randomUUID()
    await owner.start("test", cwd, { conversationId: id })
    await until(() => owner.snapshot(id)?.session.status === "ready")
    const capture = holdCapture(), deadline = holdDeadline()
    try {
      const sentBefore = sent.length
      owner.submit(id, request, "edit the answer")
      await until(() => capture.reading() && deadline.armed() && sent.length === sentBefore + 1)
      assert.equal(owner.snapshot(id)?.requests[0].snapshots?.before, undefined, "the provider has the message before the checkpoint holds the workspace")
      const write = holds.beforeWrite(bindingOf(id))
      assert.ok(holds.attends(bindingOf(id)), "a holding harness's launch holds its writes")
      assert.equal(await settlesWithin(write, 50), false, "the agent's first write waits for the checkpoint")
      // Its writes wait, so the person steers the running turn as any: the read doesn't hold the steer.
      await until(() => owner.snapshot(id)?.requests[0].nativeRun !== undefined)
      const steer = randomUUID(), words = "use the existing file"
      owner.submit(id, steer, words)
      const receipt = await owner.act(id, { kind: "steer-queued", id: randomUUID(), requestId: request, queuedRequestId: steer, text: words, attachments: [] })
      assert.equal(receipt.state.kind, "accepted", "a steer into the turn is taken while its checkpoint still reads")
      assert.equal(steered.at(-1), words)
      capture.release()
      assert.equal(await settlesWithin(write, 10_000), true, "the write goes once the checkpoint holds the workspace")
      writeFileSync(file, "the agent's edit")
      await until(() => owner.snapshot(id)?.requests[0].snapshots?.before !== undefined)
      assert.equal(owner.snapshot(id)?.requests[0].snapshots?.before.kind, "ready", "a checkpoint that held the workspace before any write is the turn's before")
      assert.equal(await settlesWithin(holds.beforeWrite(bindingOf(id)), 50), true, "once the checkpoint holds the workspace, a write goes at once")
      finish(id, "edited")
      await until(() => owner.snapshot(id)?.requests[0].snapshots?.after?.kind === "ready")
      const preview = await owner.previewRewind(id, request, "before")
      await owner.rewind(id, { id: randomUUID(), requestId: request, position: "before", expectedId: preview.current.id })
      assert.equal(readFileSync(file, "utf8"), "initial", "rewinding to before undoes the agent's write: the checkpoint never held it")
    } finally {
      deadline.restore()
      capture.release()
      capture.restore()
    }
    console.log("PASS: a holding harness's message goes at once; its first write waits for the checkpoint, which never holds it")
  }

  // The wait runs out: the write goes, and the capture held after it is never the turn's before.
  {
    await owner.stop()
    owner = new LiveConversations(dependencies)
    writeFileSync(file, "initial")
    const id = randomUUID(), request = randomUUID()
    await owner.start("test", cwd, { conversationId: id })
    await until(() => owner.snapshot(id)?.session.status === "ready")
    const capture = holdCapture(), deadline = holdDeadline()
    try {
      const sentBefore = sent.length
      owner.submit(id, request, "edit late")
      await until(() => capture.reading() && deadline.armed() && sent.length === sentBefore + 1)
      const write = holds.beforeWrite(bindingOf(id))
      assert.equal(await settlesWithin(write, 50), false, "the write waits while the deadline stands")
      deadline.expire()
      assert.equal(await settlesWithin(write, 10_000), true, "the deadline lets the write go")
      writeFileSync(file, "written before the checkpoint held the workspace")
      capture.release()
      const reasonOf = () => { const before = owner.snapshot(id)?.requests[0].snapshots?.before; return before?.kind === "unavailable" ? before.reason : "" }
      await until(() => owner.snapshot(id)?.requests[0].snapshots?.before?.kind === "ready" || /after the agent first wrote/.test(reasonOf()))
      const before = owner.snapshot(id)?.requests[0].snapshots?.before
      assert.ok(before?.kind === "unavailable" && before.timedOut === true, "a capture held after writes could run is never the turn's before")
      finish(id, "late")
      await until(() => owner.snapshot(id)?.requests[0].snapshots?.after !== undefined)
      await assert.rejects(owner.previewRewind(id, request, "before"), /no workspace checkpoint at that point/, "a rewind to it refuses")
    } finally {
      deadline.restore()
      capture.release()
      capture.restore()
    }
    console.log("PASS: when the wait runs out the write goes, and the late capture is never the turn's before")
  }

  // The wait runs out and the agent writes nothing: the late capture still holds the workspace as the turn started.
  {
    await owner.stop()
    owner = new LiveConversations(dependencies)
    writeFileSync(file, "initial")
    const id = randomUUID(), request = randomUUID()
    await owner.start("test", cwd, { conversationId: id })
    await until(() => owner.snapshot(id)?.session.status === "ready")
    const capture = holdCapture(), deadline = holdDeadline()
    try {
      const sentBefore = sent.length
      owner.submit(id, request, "answer without writing")
      await until(() => capture.reading() && deadline.armed() && sent.length === sentBefore + 1)
      deadline.expire()
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(owner.snapshot(id)?.requests[0].snapshots?.before, undefined, "the deadline alone marks nothing")
      capture.release()
      await until(() => owner.snapshot(id)?.requests[0].snapshots?.before !== undefined)
      assert.equal(owner.snapshot(id)?.requests[0].snapshots?.before.kind, "ready", "a turn that wrote nothing keeps its checkpoint, however long the capture took")
      // A write asked for now, the capture done, goes at once and changes nothing.
      assert.equal(await settlesWithin(holds.beforeWrite(bindingOf(id)), 50), true, "a write after the capture goes at once")
      assert.equal(owner.snapshot(id)?.requests[0].snapshots?.before.kind, "ready")
      finish(id, "answered")
      await until(() => owner.snapshot(id)?.requests[0].snapshots?.after !== undefined)
    } finally {
      deadline.restore()
      capture.release()
      capture.restore()
    }
    console.log("PASS: a turn that writes nothing keeps its checkpoint when the capture outlasts the deadline")
  }

  // A tool cancelled while it waits goes at once and wrote nothing: the late capture is still the turn's before.
  {
    await owner.stop()
    owner = new LiveConversations(dependencies)
    const id = randomUUID(), request = randomUUID()
    await owner.start("test", cwd, { conversationId: id })
    await until(() => owner.snapshot(id)?.session.status === "ready")
    const capture = holdCapture(), deadline = holdDeadline()
    try {
      const sentBefore = sent.length
      owner.submit(id, request, "start then stop")
      await until(() => capture.reading() && deadline.armed() && sent.length === sentBefore + 1)
      const stop = new AbortController()
      const write = holds.beforeWrite(bindingOf(id), stop.signal)
      assert.equal(await settlesWithin(write, 50), false)
      stop.abort()
      assert.equal(await settlesWithin(write, 50), true, "a cancelled tool lets go at once")
      deadline.expire()
      capture.release()
      await until(() => owner.snapshot(id)?.requests[0].snapshots?.before !== undefined)
      assert.equal(owner.snapshot(id)?.requests[0].snapshots?.before.kind, "ready", "a cancelled tool wrote nothing")
      finish(id, "stopped")
      await until(() => owner.snapshot(id)?.requests[0].snapshots?.after !== undefined)
    } finally {
      deadline.restore()
      capture.release()
      capture.restore()
    }
    console.log("PASS: a tool cancelled while it waits lets go at once and leaves the checkpoint ready")
  }

  // A launch whose writes aren't held (the person's own hooks run beside the harness's): the message waits as ever.
  {
    await owner.stop()
    owner = new LiveConversations(dependencies)
    attended = false
    const id = randomUUID(), request = randomUUID()
    await owner.start("test", cwd, { conversationId: id })
    await until(() => owner.snapshot(id)?.session.status === "ready")
    const capture = holdCapture(), deadline = holdDeadline()
    try {
      const sentBefore = sent.length
      owner.submit(id, request, "not held")
      await until(() => capture.reading() && deadline.armed())
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(sent.length, sentBefore, "an unheld launch's message waits for its checkpoint")
      assert.equal(holds.attends(bindingOf(id)), false, "and holds no write")
      capture.release()
      await until(() => sent.length === sentBefore + 1 && owner.snapshot(id)?.requests[0].snapshots?.before !== undefined)
      assert.equal(owner.snapshot(id)?.requests[0].snapshots?.before.kind, "ready")
      finish(id, "waited")
      await until(() => owner.snapshot(id)?.requests[0].snapshots?.after !== undefined)
    } finally {
      attended = true
      deadline.restore()
      capture.release()
      capture.restore()
    }
    console.log("PASS: a launch whose writes aren't held sends only once its checkpoint holds the workspace")
  }

  // Whether the person's own Claude Code setup runs code beside Mako's hook: any hook, a plugin, or settings unread.
  {
    const home = join(root, "person-home"), project = join(root, "person-project")
    mkdirSync(join(home, ".claude"), { recursive: true })
    mkdirSync(join(project, ".claude"), { recursive: true })
    const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") }
    const managed = existsSync(process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json")
    if (!managed) assert.equal(await personCodeRuns(env, project), false, "no settings: nothing of the person's runs")
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", hooks: {} }))
    if (!managed) assert.equal(await personCodeRuns(env, project), false, "settings with no hooks or plugins")
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "touch x" }] }] } }))
    assert.equal(await personCodeRuns(env, project), true, "a hook on any event, a Stop's included")
    rmSync(join(project, ".claude", "settings.local.json"))
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "formatter@market": true } }))
    assert.equal(await personCodeRuns(env, project), true, "an enabled plugin, which may bring hooks")
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json")
    assert.equal(await personCodeRuns(env, project), true, "settings Mako can't read")
    console.log(`PASS: a launch holds writes only where none of the person's own Claude Code setup runs beside the hook${managed ? " (managed settings present here: their absence wasn't checked)" : ""}`)
  }

  // Claude's hook: a tool that may write waits on the hold; one that only reads, or an unheld binding, goes at once.
  {
    const gate = Promise.withResolvers<void>()
    // As the driver hands it: the hold, or the tool's cancellation, whichever comes first.
    const hooks = claudeCallHooks(new CallBounds("claude-binding"), undefined, (signal) => Promise.race([gate.promise, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]))
    /** The inputs these calls carry, as Claude's tools name them. */
    type ToolInput = { file_path?: string; old_string?: string; new_string?: string; command?: string; pattern?: string }
    const preToolUse = (tool_name: string, tool_input: ToolInput): PreToolUseHookInput => ({
      hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: randomUUID(), session_id: "s", transcript_path: "t", cwd,
    })
    const call = (tool_name: string, tool_input: ToolInput, signal = new AbortController().signal) => hooks.pre(preToolUse(tool_name, tool_input), undefined, { signal })
    assert.equal(await settlesWithin(call("Read", { file_path: file }), 50), true, "a read goes at once")
    assert.equal(await settlesWithin(call("Grep", { pattern: "x" }), 50), true, "a search goes at once")
    const edit = call("Edit", { file_path: file, old_string: "a", new_string: "b" })
    const bash = call("Bash", { command: "echo hi > answer" })
    const mcp = call("mcp__other__write", {})
    assert.equal(await settlesWithin(Promise.race([edit, bash, mcp]), 50), false, "an edit, a command and an MCP tool wait")
    const stopped = new AbortController()
    const cancelled = call("Write", { file_path: file }, stopped.signal)
    stopped.abort()
    assert.equal(await settlesWithin(cancelled, 50), true, "a cancelled tool lets go at once")
    gate.resolve()
    assert.equal(await settlesWithin(Promise.all([edit, bash, mcp]), 1_000), true, "they go once the checkpoint holds the workspace")
    const unheld = claudeCallHooks(new CallBounds("claude-binding"), undefined, () => new WriteHolds().beforeWrite("claude-binding"))
    assert.equal(await settlesWithin(unheld.pre(preToolUse("Write", { file_path: file }), undefined, { signal: new AbortController().signal }), 50), true, "a binding with no hold writes at once")
    console.log("PASS: Claude's PreToolUse hook holds tools that may write, never reads")
  }
} finally {
  await owner.stop()
  while (captures.size) await Promise.allSettled(captures)
  snapshots.close()
  await gitRunner.close()
  rmSync(root, { recursive: true, force: true })
}
