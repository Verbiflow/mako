import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Actor, ThreadPlacement } from "@mako/host/contracts/thread-identity"
import { MoveIdSchema, RuntimeIdSchema, type ExecutionOwner, type MoveId } from "@mako/host/contracts/thread-execution"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { assessProviderResume } from "@mako/host/harnesses/provider-recovery"
import { MoveNotQuietError } from "@mako/host/conversations/live-moves"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { SessionMemory } from "@mako/host/threads/session-memory"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { ThreadStore } from "@mako/host/threads/store"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * Execution ownership in the conversation host, for all six harnesses: a
 * prompt sent while the Thread is leaving waits, nothing runs or wakes while
 * it is away, and after the round trip the waiting prompt is sent exactly
 * once under the new generation, with the same Thread and Session IDs.
 */

const HARNESSES = registeredHarnessIds()
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-execution-host-")))
const storePath = join(root, "threads.sqlite")
const CWD = "/tmp/thread-execution-project"
const cloud: ExecutionOwner = { kind: "cloud", runtime: RuntimeIdSchema.parse(randomUUID()) }
const handoffActor: Actor = { kind: "service", name: "handoff" }

interface Fixture {
  driver: ProviderLiveDriver
  starts: number
  closes: number
  prompts: string[]
  /** Leave the next turn running until `finish` is called. */
  holdTurn: boolean
  finish?: (how?: "cancelled") => void
}

function fixture(harness: string, owner: () => LiveConversations): Fixture {
  const sessions = new Map<string, LiveSessionState>()
  const state: Fixture = {
    starts: 0,
    closes: 0,
    prompts: [],
    holdTurn: false,
    driver: {
      ...noCapabilities,
      resume: fixtureResume({ checkpoint: async () => "checkpoint", inspect: async () => ({ kind: "available", checkpoint: "checkpoint", strategy: "same-session" }) }),
      approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
      nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
      nativeExclusion: NO_NATIVE_EXCLUSION,
      launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
      nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
      planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
      backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
      turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
      provider: harness,
      available: () => true,
      start: async (cwd, options) => {
        state.starts += 1
        const session: LiveSessionState = {
          id: options.conversationId,
          nativeId: options.resume ?? `native-${harness}-${options.conversationId}`,
          // As every real driver does: a resumed session names the source it reopened.
          nativePath: options.resume ? options.threadPath : undefined,
          harness,
          cwd,
          status: "ready",
          connection: "connected",
          modes: [],
          currentMode: null,
          configOptions: [],
        }
        sessions.set(options.conversationId, session)
        return session
      },
      prompt: async (id, text, _attachments, _settings, dispatch) => {
        dispatch.report({ kind: "submitted", source: "transport-call" })
        state.prompts.push(text)
        const session = sessions.get(id)
        assert.ok(session, "a prompt goes to a started session")
        owner().observe({ type: "live-session", session: { ...session, status: "running" } })
        // A cancel ends the turn as its provider says one it cancelled ended.
        const finish = (how?: "cancelled") => owner().observe({ type: "live-session", session: how ? { ...session, lastStop: how } : session })
        if (state.holdTurn) state.finish = finish
        else finish()
      },
      permission: async () => {},
      cancel: async () => {
        state.finish?.("cancelled")
        state.finish = undefined
      },
      setMode: async () => {},
      close: async () => { state.closes += 1 },
    },
  }
  return state
}

function host(input: { threads: ThreadStore; journals: string; fixtures: Map<string, Fixture>; memory?: SessionMemory }): LiveConversations {
  let owner: LiveConversations | undefined
  const self = () => {
    assert.ok(owner)
    return owner
  }
  for (const harness of HARNESSES) input.fixtures.set(harness, input.fixtures.get(harness) ?? fixture(harness, self))
  owner = new LiveConversations({
    root: input.journals,
    appPath: root,
    threads: input.threads,
    memory: input.memory,
    driver: (provider) => input.fixtures.get(provider)?.driver,
    history: async () => null,
    emit: () => {},
    nativePath: (session) => session.nativeId ? join(root, "native", session.harness, `${session.nativeId}.jsonl`) : undefined,
    checkpoint: async () => "checkpoint",
    resumeVerdict: binding => assessProviderResume(binding, input.fixtures.get(binding.provider)?.driver),
    providerIdleMs: 60_000,
    providerWarmLimit: 20,
  })
  return owner
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await delay(2)
  assert.ok(check(), what)
}

/** Room for anything wrongly scheduled to happen before asserting it did not. */
async function settle(): Promise<void> {
  await delay(30)
}

function moveId(): MoveId {
  return MoveIdSchema.parse(randomUUID())
}

function request(owner: LiveConversations, id: string, requestId: string): LiveRequest | undefined {
  return owner.snapshot(id)?.requests.find((candidate) => candidate.id === requestId)
}

async function startSeeded(owner: LiveConversations, harness: string): Promise<string> {
  const id = randomUUID()
  const seed = randomUUID()
  await owner.start(harness, CWD, { conversationId: id, initialRequest: { id: seed, text: "seed", attachments: [] } })
  await until(() => request(owner, id, seed)?.status === "completed", `${harness}: the first turn completes`)
  await until(() => Boolean(owner.snapshot(id)?.control?.bindings[0]?.path), `${harness}: the binding learns its native path`)
  assert.equal(request(owner, id, seed)?.nativeDelivery?.ownerGeneration, 1, `${harness}: a prompt records the generation it ran under`)
  return id
}

/**
 * A prompt sent to a hibernated conversation while its Thread is leaving
 * wakes nothing; cancelling the move wakes it and sends the prompt once,
 * under the unchanged generation.
 */
async function cancelled(owner: LiveConversations, threads: ThreadStore, fx: Fixture, harness: string, id: string, placed: ThreadPlacement): Promise<void> {
  assert.equal(owner.hibernateIfIdle(id), true)
  await until(() => owner.snapshot(id)?.session.connection === "hibernated", `${harness}: the provider hibernates`)
  const starts = fx.starts
  const move = moveId()
  owner.moves.begin({ move, thread: placed.thread, target: cloud, actor: threads.person() })
  const waiting = randomUUID()
  owner.submit(id, waiting, "sent during a cancelled move", [])
  await settle()
  assert.equal(request(owner, id, waiting)?.status, "queued", `${harness}: a prompt sent while leaving waits`)
  assert.equal(fx.starts, starts, `${harness}: it does not wake the provider`)
  assert.ok(!fx.prompts.includes("sent during a cancelled move"))
  owner.moves.cancel({ operationId: randomUUID(), move, actor: threads.person() })
  await until(() => request(owner, id, waiting)?.status === "completed", `${harness}: cancelling sends it`)
  assert.equal(fx.starts, starts + 1)
  assert.equal(fx.prompts.filter((text) => text === "sent during a cancelled move").length, 1)
  assert.equal(request(owner, id, waiting)?.nativeDelivery?.ownerGeneration, 1, `${harness}: a cancelled move changes no generation`)
}

async function roundTrip(owner: LiveConversations, threads: ThreadStore, runtime: ThreadStore, fx: Fixture, harness: string, id: string, placed: ThreadPlacement): Promise<void> {
  fx.holdTurn = true
  const running = randomUUID()
  owner.submit(id, running, "long turn", [])
  await until(() => owner.snapshot(id)?.session.status === "running", `${harness}: the long turn runs`)

  const out = moveId()
  owner.moves.begin({ move: out, thread: placed.thread, target: cloud, actor: threads.person() })
  const waiting = randomUUID()
  owner.submit(id, waiting, "sent while leaving", [])
  await assert.rejects(owner.moves.release({ operationId: randomUUID(), move: out, actor: threads.person() }),
    { name: MoveNotQuietError.name, message: /running a turn/ }, `${harness}: a running turn keeps the Thread here`)

  fx.holdTurn = false
  fx.finish?.()
  await until(() => request(owner, id, running)?.status === "completed", `${harness}: the running turn finishes`)
  await settle()
  assert.equal(request(owner, id, waiting)?.status, "queued", `${harness}: the waiting prompt is not sent while leaving`)
  assert.ok(!fx.prompts.includes("sent while leaving"))

  const startsBefore = fx.starts
  const closesBefore = fx.closes
  const handoff = await owner.moves.release({ operationId: randomUUID(), move: out, actor: threads.person() })
  assert.equal(owner.snapshot(id)?.session.connection, "hibernated", `${harness}: release closes the provider`)
  assert.equal(fx.closes, closesBefore + 1)
  assert.deepEqual(handoff.sessions.map((session) => [session.id, session.generation]), [[placed.session, 2]])
  assert.ok(handoff.sessions[0]?.journals.includes(id), `${harness}: the handoff names the journal`)

  assert.throws(() => owner.submit(id, randomUUID(), "refused", []), /moving to a cloud runtime/, `${harness}: nothing is accepted in transit`)
  const other = HARNESSES.find((name) => name !== harness) ?? "codex"
  assert.throws(() => owner.transfer(id, { id: randomUUID(), provider: other, text: "switch", attachments: [] }), /moving to a cloud runtime/)
  const nativeId = owner.snapshot(id)?.control?.bindings[0]?.nativeId
  assert.ok(nativeId)
  await assert.rejects(owner.start(harness, CWD, { conversationId: randomUUID(), resume: nativeId }), /moving to a cloud runtime/,
    `${harness}: its native session cannot be reopened here`)

  const receipt = runtime.claim({ operationId: randomUUID(), handoff, actor: handoffActor })
  owner.moves.confirm({ operationId: randomUUID(), receipt, actor: handoffActor })
  assert.throws(() => owner.submit(id, randomUUID(), "refused", []), /runs on a cloud runtime/, `${harness}: the cloud owns it now`)
  assert.equal(owner.hibernateIfIdle(id), false)
  await settle()
  assert.equal(fx.starts, startsBefore, `${harness}: nothing woke while it was away`)
  assert.equal(request(owner, id, waiting)?.status, "queued")

  const back = moveId()
  runtime.beginMove({ move: back, thread: placed.thread, target: threads.self, actor: handoffActor })
  const returned = runtime.release({ operationId: randomUUID(), move: back, actor: handoffActor })
  owner.moves.claim({ operationId: randomUUID(), handoff: returned, actor: handoffActor })
  await until(() => request(owner, id, waiting)?.status === "completed", `${harness}: the waiting prompt is sent once home`)
  assert.equal(fx.prompts.filter((text) => text === "sent while leaving").length, 1, `${harness}: exactly once`)
  assert.equal(request(owner, id, waiting)?.nativeDelivery?.ownerGeneration, 5, `${harness}: under the generation it came home with`)
  assert.equal(fx.starts, startsBefore + 1, `${harness}: one resume`)
  assert.ok(!fx.prompts.includes("refused"))
  assert.deepEqual(threads.journalPlacement(id), placed, `${harness}: the same Thread and Session IDs`)
}

/**
 * A handoff's pause and continuation, here: the running turn stops as `handed-off` (not the person's Stop), the
 * message waiting behind it is held, then carried (it runs where the Thread went, never here), and Mako's
 * continuation runs once however often it's asked.
 */
async function handedOff(owner: LiveConversations, fx: Fixture, harness: string, id: string): Promise<void> {
  fx.holdTurn = true
  const running = randomUUID()
  owner.submit(id, running, "a long turn to hand off", [])
  await until(() => owner.snapshot(id)?.session.status === "running", `${harness}: the turn runs`)
  const waiting = randomUUID()
  owner.submit(id, waiting, "waiting behind it", [])
  fx.holdTurn = false
  assert.deepEqual(await owner.handOff(id), { requestId: running, stopped: [] }, `${harness}: the handoff pauses the running turn`)
  await until(() => request(owner, id, running)?.status === "interrupted", `${harness}: it settles interrupted`)
  assert.equal(request(owner, id, running)?.interruption?.reason, "handed-off", `${harness}: as handed off, not stopped`)
  assert.equal(request(owner, id, running)?.interruption?.autoContinue, undefined, `${harness}: nothing continues it here on its own`)
  assert.equal(request(owner, id, waiting)?.status, "held", `${harness}: the waiting message is held for the Thread`)
  assert.deepEqual(owner.waitingPrompts(id).map((prompt) => prompt.id), [waiting])
  owner.carried(id, [waiting], "cloud")
  assert.deepEqual([request(owner, id, waiting)?.status, request(owner, id, waiting)?.carried?.to], ["canceled", "cloud"], `${harness}: carried, it never runs here`)
  assert.deepEqual(owner.waitingPrompts(id), [])
  const continuation = randomUUID()
  owner.continueTurn(id, { requestId: continuation, reason: "handed-off", continues: running, actor: handoffActor })
  owner.continueTurn(id, { requestId: continuation, reason: "handed-off", continues: running, actor: handoffActor })
  await until(() => request(owner, id, continuation)?.status === "completed", `${harness}: Mako's continuation runs`)
  const sent = request(owner, id, continuation)
  assert.deepEqual(sent?.continues, { requestId: running, reason: "handed-off", auto: true })
  assert.deepEqual(sent?.actor, handoffActor)
  assert.equal(fx.prompts.filter((text) => text.startsWith("Continue where you left off. Mako stopped your work to hand this conversation")).length, 1, `${harness}: once`)
  assert.ok(!fx.prompts.includes("waiting behind it"), `${harness}: the carried message never ran here`)
}

/**
 * Two hosts on one Mac: host B has the Session's native session live, so
 * host A cannot release the Thread; once B is quiet A can, and B then
 * neither sends nor wakes.
 */
async function twoHosts(harness: string): Promise<void> {
  const memoryPath = join(root, `memory-${harness}.sqlite`)
  const alive = { alive: () => true }
  const memoryA = new SessionMemory(memoryPath, { pid: process.pid, startedAt: 1, label: "host A" }, alive)
  const memoryB = new SessionMemory(memoryPath, { pid: process.pid + 100_000, startedAt: 2, label: "host B" }, alive)
  const storeA = new ThreadStore(join(root, `race-${harness}.sqlite`), { realPath: (path) => path })
  const storeB = new ThreadStore(join(root, `race-${harness}.sqlite`), { realPath: (path) => path })
  const fixturesA = new Map<string, Fixture>()
  const fixturesB = new Map<string, Fixture>()
  const a = host({ threads: storeA, journals: join(root, `race-${harness}-a`), fixtures: fixturesA, memory: memoryA })
  const b = host({ threads: storeB, journals: join(root, `race-${harness}-b`), fixtures: fixturesB, memory: memoryB })
  try {
    const id = await startSeeded(a, harness)
    const placed = storeA.journalPlacement(id)
    assert.ok(placed)
    assert.equal(a.hibernateIfIdle(id), true)
    await until(() => a.snapshot(id)?.session.connection === "hibernated", `${harness}: host A lets go`)
    const nativeId = a.snapshot(id)?.control?.bindings[0]?.nativeId
    assert.ok(nativeId)
    const other = randomUUID()
    await b.start(harness, CWD, { conversationId: other, resume: nativeId, initialRequest: { id: randomUUID(), text: "from host B", attachments: [] } })
    await until(() => b.snapshot(other)?.requests[0]?.status === "completed", `${harness}: host B runs its turn`)
    await until(() => storeA.journalPlacement(other)?.session === placed.session, `${harness}: host B's journal joins the Session`)

    const move = moveId()
    a.moves.begin({ move, thread: placed.thread, target: cloud, actor: storeA.person() })
    const waiting = randomUUID()
    b.submit(other, waiting, "sent to host B while leaving", [])
    await assert.rejects(a.moves.release({ operationId: randomUUID(), move, actor: storeA.person() }),
      { name: MoveNotQuietError.name, message: /open in host B/ }, `${harness}: host B's live session keeps it here`)
    await settle()
    assert.equal(request(b, other, waiting)?.status, "queued", `${harness}: host B holds the prompt too`)

    assert.equal(b.hibernateIfIdle(other), true, `${harness}: a leaving Session hibernates with prompts waiting`)
    await until(() => b.snapshot(other)?.session.connection === "hibernated", `${harness}: host B lets go`)
    await a.moves.release({ operationId: randomUUID(), move, actor: storeA.person() })
    const startsB = fixturesB.get(harness)?.starts
    assert.throws(() => b.submit(other, randomUUID(), "refused", []), /moving to a cloud runtime/, `${harness}: host B refuses in transit`)
    b.submit(other, waiting, "sent to host B while leaving", [])
    await settle()
    assert.equal(fixturesB.get(harness)?.starts, startsB, `${harness}: host B does not wake it`)
    assert.ok(!fixturesB.get(harness)?.prompts.includes("sent to host B while leaving"))
  } finally {
    await a.stop()
    await b.stop()
    storeA.close()
    storeB.close()
    memoryA.close()
    memoryB.close()
  }
}

async function main(): Promise<void> {
  const threads = new ThreadStore(storePath, { realPath: (path) => path })
  const runtime = new ThreadStore(join(root, "cloud.sqlite"), { realPath: (path) => path, self: cloud })
  const fixtures = new Map<string, Fixture>()
  const journals = join(root, "journals")
  let owner = host({ threads, journals, fixtures })
  const placements = new Map<string, ThreadPlacement>()
  for (const harness of HARNESSES) {
    const fx = fixtures.get(harness)
    assert.ok(fx)
    const id = await startSeeded(owner, harness)
    const placed = threads.journalPlacement(id)
    assert.ok(placed, `${harness}: the conversation has a Session`)
    await cancelled(owner, threads, fx, harness, id, placed)
    await handedOff(owner, fx, harness, id)
    await roundTrip(owner, threads, runtime, fx, harness, id, placed)
    placements.set(id, placed)
  }
  await owner.stop()
  threads.close()

  const reopened = new ThreadStore(storePath, { realPath: (path) => path })
  owner = host({ threads: reopened, journals, fixtures: new Map() })
  for (const [id, placed] of placements) {
    assert.deepEqual(reopened.journalPlacement(id), placed, "a restart keeps every Thread and Session")
    assert.deepEqual(reopened.execution(placed.session), { state: "here", owner: reopened.self, generation: 5 }, "and every owner and generation")
  }
  await owner.stop()
  reopened.close()
  runtime.close()

  for (const harness of HARNESSES) await twoHosts(harness)
  console.log(`thread execution host: ${HARNESSES.length} harnesses held while leaving, fenced away, sent once home, stable across restart, two hosts`)
}

try {
  await main()
} finally {
  rmSync(root, { recursive: true, force: true })
}
