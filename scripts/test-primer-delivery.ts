// Mako's primer on a harness without a slot of its own reaches the model in
// Mako's note, through LiveConversations with an injected driver and the
// host's own note (`makoNote`). After anything that may have kept the model
// from it (a send that failed, a compaction, a rewind, a new process for the
// binding, another binding), the next accepted prompt carries it again.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { makoNote } from "@mako/host/conversations/mako-note"
import { standingLines } from "@mako/host/conversations/control-cadence"
import { primerBlocks } from "@mako/host/contracts/primer"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { CONTEXT_COMPACTED } from "@mako/host/contracts/native-activity"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const FIXTURE = "Injected driver fixture"
const BLOCKS = primerBlocks({ role: "thread", noRecipe: false, computer: true }).map((block) => block.text)
const carries = (text: string) => BLOCKS.every((block) => text.includes(block))
const carriesAny = (text: string) => BLOCKS.some((block) => text.includes(block))

const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

/** `idleMs`: the process hibernates once idle that long, and the next message resumes its session in a new one. */
function primerHost(options: { idleMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mako-primer-delivery-"))
  const id = randomUUID()
  const sent: string[] = []
  let starts = 0
  let refuse = false
  let owner: LiveConversations
  const state = (status: LiveSessionState["status"], connection: LiveSessionState["connection"] = "connected"): LiveSessionState => ({
    id, nativeId: id, nativePath: join(root, "native-session"), harness: "test-provider", cwd: root, status, connection, modes: [], currentMode: null, configOptions: [],
  })
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    approvalEvidence: { kind: "submission-only", reason: FIXTURE },
    launchEnvironment: { kind: "unavailable", reason: FIXTURE },
    nativeIdentity: { kind: "unavailable", reason: FIXTURE },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: FIXTURE, feedback: { kind: "next-message", reason: FIXTURE } },
    backgroundStop: { kind: "ends-with-turn", evidence: FIXTURE },
    turnRecovery: { kind: "manual", reason: FIXTURE },
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async () => {
      starts += 1
      return state("ready")
    },
    prompt: async (_id, text, _attachments, _settings, dispatch) => {
      if (refuse) {
        refuse = false
        throw new Error("The harness refused the message")
      }
      dispatch.report({ kind: "submitted", source: "transport-call" })
      sent.push(text)
      owner.observe({ type: "live-session", session: state("running") })
      owner.observe({ type: "live-update", id, update: { kind: "text", text: "Done." } })
      setTimeout(() => owner.observe({ type: "live-session", session: state("ready") }), 0)
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    controlInstructions: makoNote({
      cloudMachine: false,
      launchedWith: () => undefined,
      controlLine: () => undefined,
      ownSlot: () => false,
      notices: () => [],
    }),
    ...options.idleMs !== undefined && {
      providerIdleMs: options.idleMs,
      resumeVerdict: async () => ({ kind: "resumable" as const, record: "same" as const }),
    },
  })
  const settled = () => (owner.snapshot(id)?.requests ?? []).every((request) => request.status === "completed" || request.status === "failed")
  return {
    id,
    owner,
    starts: () => starts,
    hibernated: () => owner.snapshot(id)?.session.connection === "hibernated",
    start: () => owner.start("test-provider", root, { conversationId: id }),
    send: async (text: string) => {
      const before = sent.length
      owner.submit(id, randomUUID(), text)
      await waitFor(() => sent.length === before + 1 && settled(), `"${text}" never went`)
      return sent.at(-1)!
    },
    refused: async (text: string) => {
      refuse = true
      owner.submit(id, randomUUID(), text)
      await waitFor(() => owner.snapshot(id)?.session.status === "failed", `"${text}" was never refused`)
    },
    observe: (event: Parameters<LiveConversations["observe"]>[0]) => owner.observe(event),
    cleanup: () => {
      owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

type Host = ReturnType<typeof primerHost>

/** One way the model can miss the primer: after `lose`, the next accepted prompt carries it. */
async function primerAfter(lose: (host: Host) => Promise<void>, options: { idleMs?: number } = {}) {
  const host = primerHost(options)
  try {
    await host.start()
    assert.ok(carries(await host.send("First")), "the first prompt carries the primer")
    assert.equal(carriesAny(await host.send("Second")), false, "a prompt after it doesn't repeat it")
    await lose(host)
    assert.ok(carries(await host.send("Next")), "the next accepted prompt carries the primer again")
  } finally {
    host.cleanup()
  }
}

const running = (host: Host, status: "running" | "ready") =>
  host.observe({ type: "live-session", session: { ...host.owner.snapshot(host.id)!.session, status } })

const cases: Array<[string, () => Promise<void>]> = [
  ["a send that failed", () => primerAfter((host) => host.refused("Refused"))],
  ["a compaction", () => primerAfter(async (host) => host.observe({ type: "live-update", id: host.id, update: { kind: "event", label: CONTEXT_COMPACTED } }))],
  ["a compaction the harness starts", () => primerAfter(async (host) => {
    running(host, "running")
    host.observe({ type: "live-activity", id: host.id, activity: { kind: "compacting" } })
    running(host, "ready")
  })],
  ["a rewind", () => primerAfter(async (host) => host.observe({ type: "live-rewound", id: host.id, run: "run-1" }))],
  ["a new process for the binding", () => primerAfter(async (host) => {
    const starts = host.starts()
    await waitFor(host.hibernated, "the idle provider never hibernated")
    await waitFor(() => host.starts() === starts, "the provider started again before the next message")
  }, { idleMs: 15 })],
]

cases.push(["another binding", async () => {
  const note = makoNote({ cloudMachine: false, launchedWith: () => undefined, controlLine: () => undefined, ownSlot: () => false, notices: () => [] })
  const standing = note("binding-a", "conversation", { role: "thread" }).standing
  const heard = standingLines(undefined, { bindingId: "binding-a", generation: 1 }, standing)
  assert.ok(carries(heard.lines.join("\n")), "the first binding hears the primer")
  assert.equal(standingLines(heard.said, { bindingId: "binding-a", generation: 1 }, standing).lines.length, 0, "and not again")
  const replaced = note("binding-b", "conversation", { role: "thread" }).standing
  assert.ok(carries(standingLines(heard.said, { bindingId: "binding-b", generation: 1 }, replaced).lines.join("\n")), "the binding that replaces it hears it whole")
}])

const failed: string[] = []
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`  ok: the primer after ${name}`)
  } catch (error) {
    failed.push(name)
    console.log(`  FAIL: the primer after ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
assert.deepEqual(failed, [], `the primer was lost after ${failed.join(", ")}`)
console.log("primer delivery: the next accepted prompt carries the primer after a failed send, a compaction, a rewind, a new process or another binding")
