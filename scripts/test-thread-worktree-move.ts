import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { moveHold, moveSource, ThreadWorktreeMoves, type ThreadWorktreeMoveDeps } from "@mako/host/workspaces/thread-worktree-moves"
import { WorkspaceMoves } from "@mako/host/workspaces/moves"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { ProviderLiveDriver, ProviderStartOptions } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import type { MoveOutcome } from "@mako/host/contracts/workspace-moves"

/** A move's outcome that took `files` and left nothing behind. */
const cameAlong = (files: number): MoveOutcome => {
  const none = { files: 0, lines: 0, paths: [] }
  return { came: { files, lines: 0, paths: [] }, stayed: { others: none, person: none, uncertain: none, unattributed: none }, split: [], brought: false, unstaged: [] }
}

const gitRunner = new Git()

/**
 * A Thread moving onto its own branch, composed as the host composes it:
 * real conversations on fixture harnesses, `ThreadWorktreeMoves` carrying each, and
 * `WorkspaceMoves` deciding when. Whether the person moves it from the
 * composer or an agent asks, every Session of the Thread in that checkout
 * comes along, each as itself where its harness resumes in another folder or
 * it hasn't launched yet, and as a fork where it can't, and nothing moves
 * while one is still busy.
 */

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await delay(5)
  assert.ok(check(), what)
}

/** Snapshots whose end-of-turn checkpoint waits until `release`, as a large workspace's does. */
class HeldSnapshots extends WorkspaceSnapshots {
  private held = Promise.withResolvers<void>()
  hold(): void { this.held = Promise.withResolvers<void>() }
  release(): void { this.held.resolve() }
  override async endRun(requestId: string) {
    await this.held.promise
    return super.endRun(requestId)
  }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-move-")))

function world(name: string) {
  const project = join(root, name, "project")
  const worktree = join(root, name, "worktree")
  for (const folder of [join(project, "web"), join(worktree, "web")]) mkdirSync(folder, { recursive: true })
  const starts: { provider: string; cwd: string; options: ProviderStartOptions }[] = []
  const folders = new Map<string, string>()
  let owner: LiveConversations | undefined
  const state = (provider: string, cwd: string, id: string, nativeId: string): LiveSessionState => ({
    id, nativeId, nativePath: join(root, name, `${nativeId}.jsonl`), harness: provider, cwd, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [],
  })
  const natives = new Map<string, string>()
  const driver = (provider: string, elsewhere: boolean): ProviderLiveDriver => ({
    ...noCapabilities,
    resume: fixtureResume(elsewhere ? { elsewhere: { via: "fixture", verified: "fixture" } } : {}),
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider, available: () => true,
    start: async (cwd, options) => {
      starts.push({ provider, cwd, options })
      const nativeId = options.resume ?? `native-${options.conversationId}`
      natives.set(options.conversationId, nativeId)
      folders.set(options.conversationId, cwd)
      return state(provider, cwd, options.conversationId, nativeId)
    },
    prompt: async (id) => {
      const session = state(provider, folders.get(id)!, id, natives.get(id)!)
      owner!.observe({ type: "live-session", session: { ...session, status: "running" } })
      owner!.observe({ type: "live-session", session })
    },
    permission: async () => {}, cancel: async () => {}, setMode: async () => {}, close: async () => {},
  })
  const drivers = new Map([["goes", driver("goes", true)], ["stays", driver("stays", false)]])
  const snapshots = new HeldSnapshots(gitRunner, join(root, name, "snapshots"))
  snapshots.release()
  let moves: WorkspaceMoves | undefined
  owner = new LiveConversations({
    root: join(root, name, "journals"), appPath: root, driver: (provider) => drivers.get(provider),
    history: async () => null, emit() {}, providerIdleMs: 60_000, providerWarmLimit: 10,
    checkpoint: async () => "checkpoint", workspaceSnapshots: snapshots,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    settled: (id) => moves?.settled(id),
  })
  const conversations = owner

  // The Thread's one worktree: made around the folder the move starts from, joined after.
  const made: string[] = []
  let attached = false
  const inWorktree = (cwd: string) => {
    const inside = join(worktree, relative(project, cwd))
    return existsSync(inside) ? inside : worktree
  }
  const worktrees: ThreadWorktreeMoveDeps["worktrees"] = {
    joinFolder: async (_source, _owner, cwd) => attached ? inWorktree(cwd) : undefined,
    prepareFork: async (_source, _owner, from) => {
      made.push(from)
      return { cwd: inWorktree(from), path: worktree, branch: "mako/thread", copied: 0, tookMs: 0, spare: false }
    },
    moveChanges: async () => cameAlong(3),
    attach: async () => { attached = true },
    abandon: async () => {},
    threadCheckout: () => attached ? { path: worktree } : undefined,
    ofConversation: () => attached ? { branch: "mako/thread" } : undefined,
  }
  const events: Extract<HostEvent, { type: "workspace-moved" }>[] = []
  const archived = new Set<string>()
  const failures: string[] = []
  const elsewhere = new Set<string>()
  const thread = new ThreadWorktreeMoves({
    conversations, worktrees,
    threadOf: (id) => !conversations.session(id) ? undefined : elsewhere.has(id) ? "another thread" : "thread",
    archived: (id) => archived.has(id),
    archive: (id) => archived.add(id),
    moved: (event) => events.push(event),
    launch: async (_harness, _cwd, tuning) => tuning,
    movedPaths: async (_thread, from, to) => ({ root: { from, to }, renamed: [{ was: join(from, "old.ts"), now: join(to, "new.ts") }], stayed: [], more: 0 }),
    warn: () => {},
  })
  moves = new WorkspaceMoves({
    file: join(root, name, "workspace-moves.json"),
    source: (id) => moveSource(conversations, id),
    companions: (id) => thread.companions(id),
    place: async (id, cwd) => ({ project: thread.project(id) ?? cwd, changed: 3 }),
    move: async (id) => (await thread.carry(id, { lead: true, tell: true })).session.id,
    follow: async (id, told, lead) => { await thread.carry(id, { lead: false, tell: told, after: lead }) },
    announce: () => {},
    failed: (_id, message) => failures.push(message),
  })
  const workspace = moves

  /** A Session of the Thread with one answer to go on from. */
  async function session(provider: string, cwd: string, title: string) {
    const id = randomUUID()
    await conversations.start(provider, cwd, { conversationId: id, title })
    conversations.submit(id, randomUUID(), `Work in ${title}`)
    await until(() => conversations.snapshot(id)?.requests[0]?.status === "completed", `${title} answered`)
    return id
  }
  const said = (id: string) => (conversations.snapshot(id)?.requests ?? []).map((request) => request.text)
  return { project, worktree, conversations, thread, workspace, snapshots, starts, made, events, archived, elsewhere, failures, session, said }
}

try {
  // The person moves the Thread from the composer while the last turn's checkpoint is still being saved.
  const person = world("person")
  const lead = await person.session("goes", person.project, "Lead")
  const helper = await person.session("goes", join(person.project, "web"), "Helper")
  const forked = await person.session("stays", person.project, "Elsewhere")
  const neighbour = await person.session("goes", person.project, "Another Thread's")
  person.elsewhere.add(neighbour)
  const shelved = await person.session("goes", person.project, "Archived")
  person.archived.add(shelved)
  await until(() => person.conversations.lifecycleWork().length === 0, "the turns settled")
  // A fork from an answer that hasn't run a turn: nothing of it is stored against its folder yet.
  const answer = person.conversations.snapshot(lead)!.requests[0]!
  const unlaunched = person.conversations.fork(lead, { id: randomUUID(), provider: "stays", point: { kind: "run", requestId: answer.id }, thread: "parent" }).session.id
  const unlaunchedTitle = person.conversations.session(unlaunched)!.title
  assert.match(await person.workspace.ask(helper), /^Asked the user/, "the helper's agent had asked to move")
  assert.deepEqual(person.thread.companions(lead).sort(), [helper, forked, unlaunched].sort(), "the Thread's other Sessions in this checkout are its companions")
  const offered = (conversation?: string) => moveHold(person.conversations, person.thread, person.workspace, { thread: "thread", cwd: person.project, conversation })
  const byId = <T extends { id: string }>(items: T[]) => items.toSorted((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(byId(offered(lead).companions), byId([{ id: helper, title: "Helper" }, { id: forked, title: "Elsewhere" }, { id: unlaunched, title: unlaunchedTitle }]),
    "before it's chosen, the composer hears who comes along and that nothing holds them")
  assert.equal(offered(lead).held, undefined)
  assert.deepEqual(offered().companions.map(({ id }) => id).sort(), [lead, helper, forked, unlaunched].sort(), "a Thread in the viewer counts every Session of it here")

  person.snapshots.hold()
  const turn = randomUUID()
  person.conversations.submit(lead, turn, "One more turn")
  await until(() => person.conversations.snapshot(lead)?.requests.find((request) => request.id === turn)?.status === "completed", "the last turn answered")
  assert.deepEqual(person.conversations.relocation(lead), { kind: "wait", reason: "is saving or rewinding its workspace" })
  assert.equal(offered(lead).held, "this session is saving or rewinding its workspace", "and what holds the move while it's saved")
  const last = person.conversations.snapshot(lead)!.requests.at(-1)!
  const input = { id: randomUUID(), provider: "goes", point: { kind: "run" as const, requestId: last.id }, thread: "parent" as const, worktree: true, move: true }
  const moving = person.workspace.moveNow(lead, (told) => person.thread.carry(lead, { lead: true, tell: told, input }))
  await delay(30)
  assert.deepEqual(person.made, [], "nothing moves while the checkpoint is being saved")
  person.snapshots.release()
  const { moved, following } = await moving
  assert.equal(moved.session.id, lead, "the person's Session goes on as itself")
  assert.equal(moved.session.cwd, person.worktree)
  assert.deepEqual(person.made, [person.project], "one worktree, made around the outermost of the Thread's folders")
  assert.deepEqual(person.said(lead).filter((text) => text.startsWith("You're on")), [], "the person's own Session isn't sent a message")
  await following
  assert.deepEqual(person.failures, [])

  const helperNow = person.conversations.snapshot(helper)!
  assert.equal(helperNow.session.cwd, join(person.worktree, "web"), "a companion goes on in the same folder inside the worktree")
  const resumed = person.starts.findLast((start) => start.options.resume === `native-${person.conversations.snapshot(helper)!.control!.bindings[0]!.id}`)
  assert.equal(resumed?.cwd, join(person.worktree, "web"), "under its own native session")
  assert.ok(person.said(helper).some((text) => text.startsWith("You're on this Thread's own branch now, mako/thread")), "the companion whose agent had asked hears where it is")

  const helperEvent = person.events.find((event) => event.from === helper)
  assert.deepEqual(helperEvent, { type: "workspace-moved", from: helper, to: helper, changed: 0, told: true, branch: "mako/thread", lead, title: "Helper" })
  const forkEvent = person.events.find((event) => event.from === forked)!
  assert.ok(forkEvent && forkEvent.to !== forked, "a companion whose harness can't go on elsewhere forks")
  assert.equal(person.conversations.snapshot(forkEvent.to)?.session.cwd, person.worktree, "into the same worktree")
  assert.equal(forkEvent.told, false, "quietly")
  assert.ok(person.archived.has(forked), "and the Session it left is archived")
  assert.ok(!person.archived.has(lead) && !person.archived.has(helper))

  assert.deepEqual(person.events.find((event) => event.from === unlaunched), { type: "workspace-moved", from: unlaunched, to: unlaunched, changed: 0, told: false, branch: "mako/thread", lead, title: unlaunchedTitle },
    "a Session with no turn of its own goes as itself, whatever its harness")
  assert.equal(person.conversations.session(unlaunched)?.cwd, person.worktree)
  assert.ok(!person.archived.has(unlaunched))
  assert.equal(person.conversations.snapshot(unlaunched)?.control?.bindings.length, 0, "without launching it to prove anything")
  const launchedBefore = person.starts.length
  const firstTurn = randomUUID()
  person.conversations.submit(unlaunched, firstTurn, "Carry on")
  await until(() => person.conversations.snapshot(unlaunched)?.requests.find((request) => request.id === firstTurn)?.status === "completed", "the moved fork's first turn answered")
  assert.deepEqual(person.starts.slice(launchedBefore).map((start) => [start.provider, start.cwd]), [["stays", person.worktree]], "its first turn starts in the worktree")
  assert.equal(person.events.some((event) => event.from === lead), false, "the person's window says where its own Session went")
  assert.deepEqual(person.thread.companions(lead), [], "nothing of the Thread is left behind")
  assert.deepEqual(offered(lead), { companions: [] })
  assert.equal(person.conversations.session(neighbour)?.cwd, person.project, "another Thread's Session in the same checkout stays")
  assert.equal(person.conversations.session(shelved)?.cwd, person.project, "and so does an archived one")

  // A companion still running a turn refuses the person's move, and nothing moves.
  const busy = world("busy")
  const first = await busy.session("goes", busy.project, "First")
  const second = await busy.session("goes", busy.project, "Second")
  await until(() => busy.conversations.lifecycleWork().length === 0, "the turns settled")
  const busyWorkspace = new WorkspaceMoves({
    file: join(root, "busy", "fast.json"),
    source: (id) => id === second ? { ...moveSource(busy.conversations, id)!, busy: true } : moveSource(busy.conversations, id),
    companions: (id) => busy.thread.companions(id),
    place: async () => ({ project: busy.project, changed: 0 }),
    move: async () => "", follow: async () => {}, announce: () => {}, failed: () => {},
    settleMs: 40,
  })
  assert.equal(moveHold(busy.conversations, busy.thread, busyWorkspace, { thread: "thread", cwd: busy.project, conversation: first }).held, "“Second” is running a turn",
    "the composer hears beforehand which Session holds the move")
  await assert.rejects(busyWorkspace.moveNow(first, (told) => busy.thread.carry(first, { lead: true, tell: told })),
    /“Second” is running a turn, so the Thread can't move onto its own branch yet/)
  assert.deepEqual(busy.made, [])
  assert.equal(busy.conversations.session(first)?.cwd, busy.project)

  // An agent asks and the person allows it: the same Thread move, with the asker told where it is.
  const agent = world("agent")
  const asker = await agent.session("goes", agent.project, "Asker")
  const mate = await agent.session("stays", join(agent.project, "web"), "Mate")
  await until(() => agent.conversations.lifecycleWork().length === 0, "the turns settled")
  await agent.workspace.ask(asker)
  const request = agent.workspace.state().requests[0]!
  assert.equal(request.companions, 1)
  agent.workspace.answer(request.id, "allow")
  await until(() => agent.events.length === 2, "the asker and its companion moved")
  assert.equal(agent.conversations.session(asker)?.cwd, agent.worktree)
  assert.ok(agent.said(asker).some((text) => text.startsWith("You're on this Thread's own branch now") && text.includes("This Thread's uncommitted changes came with you: 3 files")), "the asker hears where it is and what came along")
  assert.ok(agent.said(asker).some((text) =>
    text.includes(`Paths under ${agent.project} are under ${agent.worktree} now.\n\nRenamed since you last used them:\n- ${join(agent.project, "old.ts")} is ${join(agent.worktree, "new.ts")} now\n\nWork there from now on`)),
  "the asker hears which of its paths changed beyond the checkout's root")
  const mateEvent = agent.events.find((event) => event.from === mate)!
  assert.equal(mateEvent.lead, asker)
  assert.equal(agent.conversations.snapshot(mateEvent.to)?.session.cwd, join(agent.worktree, "web"))
  assert.ok(agent.archived.has(mate))

  for (const each of [person, busy, agent]) await each.conversations.stop()

  // After a restart a Session is only on disk; asked about, it isn't read in, since it runs nothing.
  const reopened = new LiveConversations({
    root: join(root, "person", "journals"), appPath: root, driver: () => undefined,
    history: async () => null, emit() {}, providerIdleMs: 60_000, providerWarmLimit: 10,
  })
  assert.equal(reopened.loaded(helper), false)
  assert.deepEqual(moveSource(reopened, helper), { cwd: join(person.worktree, "web"), harness: "goes", title: "Helper", busy: false })
  assert.equal(reopened.loaded(helper), false, "the composer's question leaves it on disk")
  await reopened.stop()
  console.log("Thread move: the person's move and an agent's each take every Session of the Thread in that checkout, as itself where its harness resumes elsewhere or it hasn't launched yet and as a fork where it can't, once the last checkpoint is saved; a busy companion refuses it, moving nothing, and the composer hears beforehand who comes along and what holds it")
} finally {
  rmSync(root, { recursive: true, force: true })
}
