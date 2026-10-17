import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Entry } from "@mako/sessions"
import { mcpServerFailedEvent } from "@mako/sessions/events"
import type { LiveUpdate } from "@mako/sessions/live-content"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// What a harness says while its session opens, such as MCP servers that
// failed, is drawn on every way a session opens: a first launch, a fork's
// first turn (forked by the harness or imported), a reconnect and a switch to
// another harness. The history a resumed or forked session replays then is
// not drawn again, and a session that fails to open leaves nothing.
const root = mkdtempSync(join(tmpdir(), "mako-opening-notices-"))
const waitFor = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 1000 && !check(); i++) await delay(5)
  assert.ok(check(), message)
}

let said: string[] = []
let failing = false
let frames = 0
const starts: { provider: string; resume?: string; fork?: string }[] = []
const emits = new Map<string, (event: LiveDriverEvent) => void>()
const replayed: LiveUpdate[] = [
  { kind: "user", text: "Where are the release notes?" },
  { kind: "text", text: "In notes.md." },
  { kind: "event", label: "Model changed", detail: "a → b" },
]
const notice = (provider: string, server: string): LiveUpdate => {
  const from = frames++ * 100
  return { kind: "event", ...mcpServerFailedEvent(server, "could not connect"), stream: { file: `mako-streams:${provider}/opening.jsonl`, ranges: [[from, from + 80]] } }
}

function driver(provider: string, fork: ProviderLiveDriver["fork"]): ProviderLiveDriver {
  const session = (bindingId: string, status: LiveSessionState["status"] = "ready", nativeRunId?: string): LiveSessionState => ({
    id: bindingId, nativeId: `native-${bindingId}`, nativePath: join(root, `native-${bindingId}`), harness: provider, cwd: root,
    status, connection: "connected", modes: [], currentMode: null, configOptions: [], nativeRunId,
  })
  let turns = 0
  return {
    ...noCapabilities,
    resume: fixtureResume(),
    fork,
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider,
    available: () => true,
    start: async (_cwd, options) => {
      const id = options.conversationId
      starts.push({ provider, ...options.resume && { resume: options.resume }, ...options.fork && { fork: options.fork.nativeId } })
      const emit = options.emit!
      emits.set(id, emit)
      // A resumed or forked session sends its history back as it opens; its setup notices come amid it.
      const resumed = options.resume !== undefined || options.fork !== undefined
      if (resumed) emit({ type: "live-updates", id, updates: replayed.slice(0, 2) })
      for (const server of said) emit({ type: "live-update", id, update: notice(provider, server) })
      if (resumed) emit({ type: "live-update", id, update: replayed[2]! })
      emit({ type: "live-session", session: { ...session(id), status: "starting", connection: "starting" } })
      await delay(1)
      if (failing) throw new Error("The harness refused to open the session")
      return { ...session(id), ...options.resume && { nativeId: options.resume } }
    },
    prompt: async (bindingId, text) => {
      const emit = emits.get(bindingId)!
      const run = `run-${provider}-${turns++}`
      emit({ type: "live-session", session: session(bindingId, "running", run) })
      emit({ type: "live-update", id: bindingId, update: { kind: "text", text: `Answer to ${text.split("\n").at(-1)}` } })
      emit({ type: "live-session", session: session(bindingId) })
    },
    permission: async () => {}, cancel: async () => {}, close: async () => {}, setMode: async () => {},
  }
}

const drivers = new Map<string, ProviderLiveDriver>([
  ["forks", driver("forks", { kind: "native", point: "run", via: "Injected driver fixture" })],
  ["imports", driver("imports", { kind: "import", via: "Injected driver fixture" })],
])
const host = () => new LiveConversations({
  appPath: root, root: join(root, "journals"), driver: (provider) => drivers.get(provider), emit: () => {},
  history: async () => null,
  resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  emitSession: async (provider) => {
    const sessionId = `imported-${provider}-${randomUUID()}`
    const path = join(root, `${sessionId}.jsonl`)
    writeFileSync(path, "")
    return { sessionId, path }
  },
})

const drawn = (blocks: readonly Entry[]) => blocks.map((block) =>
  block.type === "user" ? `user: ${block.text}`
    : block.type === "text" ? `text: ${block.text}`
      : block.type === "event" ? `${block.setup ? "setup" : "event"}: ${block.label} — ${block.detail}`
        : block.type)
const failed = (server: string) => `setup: MCP server failed — ${server} · could not connect`

try {
  let owner = host()
  const id = randomUUID()
  said = ["paper"]
  await owner.start("forks", root, { conversationId: id })
  await waitFor(() => owner.snapshot(id)?.session.status === "ready", "the launch did not open")
  owner.submit(id, randomUUID(), "Which day does the release ship?")
  await waitFor(() => owner.snapshot(id)?.requests[0]?.status === "completed", "the first turn did not finish")
  assert.deepEqual(drawn(owner.snapshot(id)!.blocks), [failed("paper"), "user: Which day does the release ship?", "text: Answer to Which day does the release ship?"],
    "a launch draws what its harness said while it opened")
  const requestId = owner.snapshot(id)!.requests[0]!.id

  // A fork the harness makes itself, and one Mako imports into a new session of another harness.
  for (const provider of ["forks", "imports"]) {
    const forkId = randomUUID()
    said = ["paper", "wisprflow"]
    owner.fork(id, { id: forkId, provider, point: { kind: "run", requestId } })
    owner.submit(forkId, randomUUID(), "And QA?")
    await waitFor(() => owner.snapshot(forkId)?.requests[0]?.status === "completed", `the ${provider} fork's turn did not finish`)
    const fork = owner.snapshot(forkId)!
    assert.equal(starts.at(-1)?.provider, provider)
    if (provider === "forks") assert.equal(starts.at(-1)?.fork, `native-${id}`, "the harness forks its own session")
    else assert.match(starts.at(-1)?.resume ?? "", /^imported-imports-/, "the fork resumes the session Mako imported")
    assert.deepEqual(drawn(fork.blocks), [failed("paper"), failed("wisprflow"), "user: And QA?", "text: Answer to And QA?"],
      `a ${provider} fork draws what its harness said while it opened, before its first prompt, and none of the history it replayed`)
    const paper = fork.blocks[0]!
    assert.equal(paper.stream?.file, `mako-streams:${provider}/opening.jsonl`, "the notice keeps the stream line it came from")
  }

  // After a restart the conversation reconnects to its session; a notice it already shows isn't drawn twice.
  owner.close(id)
  await waitFor(() => owner.snapshot(id)?.session.connection !== "connected", "the conversation did not close")
  owner = host()
  said = ["paper", "todoist"]
  owner.submit(id, randomUUID(), "Which day does QA sign off?")
  await waitFor(() => owner.snapshot(id)?.requests.at(-1)?.status === "completed", "the reconnected turn did not finish")
  assert.equal(starts.at(-1)?.resume, `native-${id}`, "the conversation resumes its own session")
  assert.deepEqual(drawn(owner.snapshot(id)!.blocks).slice(3), [failed("todoist"), "user: Which day does QA sign off?", "text: Answer to Which day does QA sign off?"],
    "a reconnect draws its new notice once and none of the replayed history")

  // Switching to another harness opens a new session there.
  said = ["axiom"]
  const review = randomUUID()
  owner.transfer(id, { id: review, provider: "imports", text: "Review it", attachments: [] })
  await waitFor(() => owner.snapshot(id)?.requests.find((request) => request.id === review)?.status === "completed", "the switched turn did not finish")
  assert.deepEqual(drawn(owner.snapshot(id)!.blocks).slice(-3), [failed("axiom"), "user: Review it", "text: Answer to Review it"],
    "a switch draws what the new harness said while it opened")

  // A session that fails to open leaves nothing it said in the conversation.
  const before = drawn(owner.snapshot(id)!.blocks)
  failing = true
  said = ["linear"]
  owner.transfer(id, { id: randomUUID(), provider: "forks", text: "Back to the first", attachments: [] })
  await waitFor(() => owner.snapshot(id)?.control?.transfers.at(-1)?.state.kind === "failed", "the failing switch did not fail")
  assert.deepEqual(drawn(owner.snapshot(id)!.blocks), before, "a failed open draws nothing its harness said")
  failing = false

  // The journal holds them: a host reading it back draws the same.
  const shown = drawn(owner.snapshot(id)!.blocks)
  owner.close(id)
  await waitFor(() => owner.snapshot(id)?.session.connection !== "connected", "the conversation did not close")
  assert.deepEqual(drawn(host().snapshot(id)!.blocks), shown, "the journal keeps what each opening drew")

  console.log("PASS: what a harness says while its session opens is drawn on a launch, a native and an imported fork, a reconnect and a switch, once, without the history it replays; a failed open draws none of it")
} finally {
  rmSync(root, { recursive: true, force: true })
}
