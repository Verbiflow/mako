import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { mcpServerFailedEvent } from "@mako/sessions/events"
import type { LiveUpdate } from "@mako/sessions/live-content"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * What the host spends on what a harness says while its session opens: a
 * resumed or forked session sends its whole history back then, and the host
 * keeps only its setup notices (`drawnWhileOpening`), on each way a session
 * opens:
 *
 *   npm run bench:opening
 *
 * - a launch that resumes a session, and a reconnect after a restart, which
 *   wakes it: the conversation already listens to the binding;
 * - a fork's first turn, which a transfer opens on a binding the
 *   conversation listens to only once it opens (`transferOpening`).
 *
 * Each replays 1,000 to 100,000 updates in batches of 100, as ACP's
 * `session/load` does, with five setup notices amid them; the time is the
 * host's, in the driver's `emit` calls, per update.
 */
const root = mkdtempSync(join(tmpdir(), "mako-bench-opening-"))
const SIZES = [1_000, 10_000, 100_000]
const BATCH = 100
const NOTICES = ["paper", "wisprflow", "todoist", "axiom", "linear"]

let replay = 0
let spent = 0
const history = (count: number): LiveUpdate[] => Array.from({ length: count }, (_, index) =>
  index % 2 ? { kind: "text", text: `Answer ${index} with some words the reply had in it.` } : { kind: "user", text: `Question ${index}` })

const session = (bindingId: string, status: LiveSessionState["status"] = "ready", nativeRunId?: string): LiveSessionState => ({
  id: bindingId, nativeId: `native-${bindingId}`, nativePath: join(root, `native-${bindingId}`), harness: "bench", cwd: root,
  status, connection: "connected", modes: [], currentMode: null, configOptions: [], nativeRunId,
})
const emits = new Map<string, NonNullable<Parameters<ProviderLiveDriver["start"]>[1]["emit"]>>()
let turns = 0
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  fork: { kind: "native", point: "run", via: "Injected driver fixture" },
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
  provider: "bench",
  available: () => true,
  start: async (_cwd, options) => {
    const id = options.conversationId
    const emit = options.emit!
    emits.set(id, emit)
    if (options.resume !== undefined || options.fork !== undefined) {
      const updates = history(replay)
      const started = performance.now()
      for (let at = 0; at < updates.length; at += BATCH) {
        emit({ type: "live-updates", id, updates: updates.slice(at, at + BATCH) })
        if (at % (updates.length / NOTICES.length) < BATCH) {
          const server = NOTICES[Math.floor(at / (updates.length / NOTICES.length))]!
          emit({ type: "live-update", id, update: { kind: "event", ...mcpServerFailedEvent(server, "could not connect") } })
        }
      }
      spent = performance.now() - started
    }
    return { ...session(id), ...options.resume && { nativeId: options.resume } }
  },
  prompt: async (bindingId) => {
    const emit = emits.get(bindingId)!
    emit({ type: "live-session", session: session(bindingId, "running", `run-${turns++}`) })
    emit({ type: "live-update", id: bindingId, update: { kind: "text", text: "Done." } })
    emit({ type: "live-session", session: session(bindingId) })
  },
  permission: async () => {}, cancel: async () => {}, close: async () => {}, setMode: async () => {},
}
const saved = { ref: { harness: "bench", nativeId: "native-saved", path: join(root, "native-saved") }, entries: [{ type: "user" as const, text: "Saved" }], start: 0, total: 1, hasEarlier: false }
const host = () => new LiveConversations({
  appPath: root, root: join(root, "journals"), driver: () => driver, emit: () => {},
  history: async () => saved,
  resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
})
const waitFor = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 4000 && !check(); i++) await delay(2)
  assert.ok(check(), message)
}
const kept = (owner: LiveConversations, id: string) =>
  owner.snapshot(id)!.blocks.filter((block) => block.type === "event" && block.setup).length

const rows: string[] = []
const row = (path: string, count: number, notices: number) =>
  rows.push(`${path.padEnd(22)} ${String(count).padStart(7)} updates  ${(spent * 1000 / count).toFixed(2).padStart(6)} µs/update  ${spent.toFixed(1).padStart(7)} ms  ${notices} notices kept`)
try {
  for (const count of SIZES) {
    replay = count
    let owner = host()
    const resumed = randomUUID()
    await owner.start("bench", root, { conversationId: resumed, resume: "native-saved", threadPath: saved.ref.path })
    await waitFor(() => owner.snapshot(resumed)?.session.status === "ready", "the resumed launch did not open")
    row("launch, resuming", count, kept(owner, resumed))

    owner.submit(resumed, randomUUID(), "Fork from here")
    await waitFor(() => owner.snapshot(resumed)?.requests[0]?.status === "completed", "the turn did not finish")
    const fork = randomUUID()
    owner.fork(resumed, { id: fork, provider: "bench", point: { kind: "run", requestId: owner.snapshot(resumed)!.requests[0]!.id } })
    owner.submit(fork, randomUUID(), "And then?")
    await waitFor(() => owner.snapshot(fork)?.requests[0]?.status === "completed", "the fork's turn did not finish")
    row("fork's first turn", count, kept(owner, fork))

    owner.close(fork)
    await waitFor(() => owner.snapshot(fork)?.session.connection !== "connected", "the fork did not close")
    owner = host()
    owner.submit(fork, randomUUID(), "Once more")
    await waitFor(() => owner.snapshot(fork)?.requests.at(-1)?.status === "completed", "the reconnected turn did not finish")
    row("reconnect", count, kept(owner, fork))
    owner.close(fork)
    owner.close(resumed)
  }
  console.log(`What the host spends on a session's opening, by the way it opens (${BATCH} updates a batch, ${NOTICES.length} setup notices amid them)`)
  for (const line of rows) console.log(line)
} finally {
  rmSync(root, { recursive: true, force: true })
}
