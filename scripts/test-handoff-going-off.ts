import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Git } from "@mako/git"
import { decodeOperation } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import type { MoveAnswer, MoveHandOverRequest } from "@mako/protocol/moves"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { partition, shares, type JournalView } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { fromHostOperation } from "@mako/host/contracts/host-operations"
import { encodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { SessionIdSchema } from "@mako/host/contracts/thread-identity"
import { CloudHandOffs, machineLeaving, workingThreads } from "@mako/host/conversations/cloud-handoffs"
import { CloudMoves, type CloudMovesOptions } from "@mako/host/conversations/cloud-moves"
import { CloudReadiness } from "@mako/host/conversations/cloud-readiness"
import { SleepHandOff } from "@mako/host/conversations/sleep-handoff"
import { WorkspaceMoves } from "@mako/host/workspaces/moves"
import { moveSource, ThreadWorktreeMoves } from "@mako/host/workspaces/thread-worktree-moves"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import type { MoveLedger } from "@mako/host/workspaces/worktree-move"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * A Mac going off with agents at work (`npm run test:handoff-going-off`): as it sleeps (the sleep watch, against a
 * stand-in for its native helper) and as it shuts down (`machineLeaving`), every Thread at work goes to the cloud, the
 * one in the project folder too. The host's own parts run: the live conversations with scripted harnesses whose turns
 * are mid-way, the Thread store, the worktree service on a real repository with the attribution journal deciding whose
 * changes are whose, the person's and an agent's moves onto a branch, and the moves, handoffs and sleep watch
 * themselves; the cloud is a stand-in that keeps its rule (one answer per move, the first). For each way off:
 * - the Thread in the project folder is paused, goes onto its own branch as the same session with only its own
 *   changes (the person's stay in the project folder, untouched), and its paused turn goes on in the cloud;
 * - the Thread in its own worktree goes the same way, its turn going on in the cloud;
 * - neither turn goes on here.
 * Kept ready while they work (`CloudReadiness`), each move takes the cloud Thread standing by for it: the one in the
 * project folder stands by at the worktree its move would make, named ahead with nothing made of it. Out of time (the
 * cloud slow to ready its machine), both stay with their turns paused, so they read idle for Continue in the cloud from
 * another device, and go on here once this Mac hears its account again (`unpark`).
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-going-off-")))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

const LONG = "Work on it for a while"
/** What a continued turn's call names: the turn it goes on from. */
const ContinuedSchema = z.object({ continues: z.string() }).loose()
/** A turn asked to work for a while runs until it's stopped; any other answers at once. */
const script: Script = async (turn) => {
  if (turn.text.includes(LONG)) {
    await turn.world.hold(turn.conversation)
    return "Cut short."
  }
  return "Done."
}

/** What the stand-in cloud saw of each move: the hand-over's calls, in order, and its answer. */
type Moved = { cloudThread: string; channels: string[]; continued: string[]; answer?: MoveAnswer }

async function host(name: string, options: { readyNever?: boolean } = {}) {
  const base = join(root, name)
  const project = join(base, "project")
  const remote = join(base, "remote.git")
  mkdirSync(base, { recursive: true })
  sh(base, "init", "--bare", "--quiet", remote)
  sh(base, "clone", "--quiet", remote, project)
  writeFileSync(join(project, "app.ts"), "export const app = 1\n")
  writeFileSync(join(project, "person.ts"), "export const person = 1\n")
  sh(project, "add", ".")
  sh(project, "commit", "--quiet", "-m", "base")
  sh(project, "push", "--quiet", "origin", "main")

  const world = new AgentsWorld({ root: join(base, "host"), script, elsewhere: true })
  // The attribution journal over the project folder, on a scripted clock: what a move takes is the Thread's own.
  const clock = new FakeClock(Date.now())
  const events = new FakeEventSource()
  const tracker = await LaptopTracker.open(
    { fs: nodeFileSystem(), events, clock, storage: join(base, "journal"), device: "going-off" },
    { repository: async (path) => gitRepository(git, path) },
  )
  await tracker.track({ id: "project", path: project, kind: "workspace" })
  const view: JournalView = { store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }
  const ledger: MoveLedger = {
    settled: () => tracker.settled(),
    track: async () => {},
    head: (repository) => [...tracker.rootStates().values()].find((state) => state.root.path === repository)?.root.head,
    partition: (checkout, thread, choice) => partition(view, checkout, thread, choice),
    shares: (checkout, thread) => shares(view, checkout, thread),
    mako: (write) => tracker.mako(write),
    moved: (move) => tracker.store.saveMove({ ...move, at: clock.now() }),
  }
  const write = (path: string, content: string) => {
    writeFileSync(path, content)
    utimesSync(path, clock.now() / 1000, clock.now() / 1000)
    events.changed(path)
  }
  /** The person edits a file in the project folder, as no agent does. */
  const personWrites = async (path: string, content: string) => {
    clock.advance(1_000)
    write(path, content)
    await tracker.settled()
  }
  /** The agent of `conversation` writes a file in its turn, as its harness reports the call. */
  const agentWrites = async (conversation: string, turn: string, path: string, content: string) => {
    const placed = world.store.journalPlacement(conversation)!
    const mark = (kind: "turn" | "call", id: string, edge: "start" | "end") => tracker.activity({ kind, id, edge, at: clock.now(), thread: placed.thread, session: placed.session, checkout: project, turn })
    clock.advance(1_000)
    mark("turn", turn, "start")
    const call = randomUUID()
    mark("call", call, "start")
    clock.advance(50)
    write(path, content)
    clock.advance(50)
    tracker.reported({ thread: placed.thread, session: placed.session, turn, call, status: "completed", endedAt: clock.now(), effects: [{ kind: "create", path, content }] })
    mark("call", call, "end")
    mark("turn", turn, "end")
    await tracker.settled()
  }

  const worktrees = new ThreadWorktreeService(git, join(base, "worktrees"), world.store, undefined, undefined, undefined, undefined, undefined, () => ledger)
  const archived = new Set<string>()
  const threadMoves = new ThreadWorktreeMoves({
    conversations: world.live,
    worktrees,
    threadOf: (id) => world.store.journalPlacement(id)?.thread,
    archived: (id) => archived.has(id),
    archive: (id) => archived.add(id),
    moved: () => {},
    launch: async (_harness, _cwd, tuning) => tuning,
    warn: () => {},
  })
  const workspace = new WorkspaceMoves({
    file: join(base, "workspace-moves.json"),
    source: (id) => moveSource(world.live, id),
    companions: (id) => threadMoves.companions(id),
    place: async (id, cwd) => ({ project: threadMoves.project(id) ?? cwd, changed: 0 }),
    move: async (id) => (await threadMoves.carry(id, { lead: true, tell: false })).session.id,
    follow: async (id, told, lead) => { await threadMoves.carry(id, { lead: false, tell: told, after: lead }) },
    announce: () => {},
    failed: () => {},
    settleMs: 2_000,
  })
  /** As "Move to its own branch" does, and as a move to the cloud does first for a Thread in the project folder. */
  const ownBranch = async (id: string, choice?: { asItself?: boolean }) => {
    const { moved, following } = await workspace.moveNow(id, () => threadMoves.carry(id, { lead: true, tell: false, ...choice?.asItself && { asItself: true } }))
    await following
    return moved.session.id
  }

  // The cloud: one answer per move, the first; a machine that takes the Thread claims it.
  const moved = new Map<string, Moved>()
  /** Each cloud Thread made, and where; and each checkpoint sent, by cloud Thread. */
  const made: Array<{ threadId: string; folder: string; url: string; standby: boolean }> = []
  const checkpoints: string[] = []
  const steps: Array<{ conversation: string; kind: string }> = []
  const account: ReturnType<CloudMovesOptions["account"]> = {
    token: async () => "token",
    gateway: () => new URL("https://gateway.test"),
    id: async () => "acct",
    session: () => { throw new Error("no session in this test") },
    deviceId: async () => randomUUID(),
    createThread: async (threadId, repository, making) => {
      made.push({ threadId, folder: making?.folder ?? "", url: repository.url, standby: making?.standby === true })
      return { ready: false }
    },
    askBases: async () => undefined,
    sendCheckpoint: async (threadId) => {
      checkpoints.push(threadId)
      return { sent: true }
    },
    handOverMove: async (_threadId, move, request: MoveHandOverRequest) => {
      const calls = request.operations.map((text) => fromHostOperation(decodeOperation(text))).flatMap((call) => (call.kind === "call" ? [call] : []))
      const continued = calls.filter((call) => call.channel === "mako:live-continue-turn").map((call) => ContinuedSchema.parse(call.args[2]).continues)
      const answer: MoveAnswer = { kind: "claimed", move, at: Date.now(), sessions: request.claim.sessions.map((session) => ({ id: session.id, generation: session.generation + 1 })) }
      if (!moved.has(move)) moved.set(move, { cloudThread: _threadId, channels: calls.map((call) => call.channel), continued, answer })
      return { move, phase: "arriving" as const, step: 0, of: request.operations.length, since: Date.now(), attempt: 1 }
    },
    refuseMove: async (_threadId, move, reason) => {
      const known = moved.get(move)?.answer
      if (known) return known
      const refused: MoveAnswer = { kind: "refused", move, at: Date.now(), reason }
      moved.set(move, { cloudThread: _threadId, channels: [], continued: [], answer: refused })
      return refused
    },
    moveAnswer: async (_threadId, move) => moved.get(move)?.answer,
    threadRecords: async (threadId) => ({ id: threadId, base: `https://gateway.test/v1/threads/${threadId}/records`, authorization: "Bearer token" }),
    deviceRecords: async (deviceId) => ({ id: deviceId, base: `https://gateway.test/v1/devices/${deviceId}/records`, authorization: "Bearer token" }),
    deviceOriginals: async (deviceId) => ({ id: deviceId, base: `https://gateway.test/v1/devices/${deviceId}/originals`, authorization: "Bearer token" }),
    readCheckpoint: () => Promise.reject(new Error("no return in this test")),
    beginReturn: () => Promise.reject(new Error("no return in this test")),
    releaseReturn: () => Promise.reject(new Error("no return in this test")),
    cancelReturn: () => Promise.reject(new Error("no return in this test")),
    giveBackReturn: () => Promise.reject(new Error("no return in this test")),
    finishReturn: () => Promise.reject(new Error("no return in this test")),
    archiveReturn: () => Promise.reject(new Error("no archive in this test")),
    returnState: () => Promise.reject(new Error("no return in this test")),
    wake: () => undefined,
    stop: () => undefined,
  }
  const cloudMoves = new CloudMoves({
    folder: join(base, "cloud", "moves"),
    git,
    account: () => account,
    threads: () => world.store,
    moves: world.live.moves,
    snapshot: (id) => world.live.snapshot(id),
    checkout: (id) => worktrees.threadCheckout(id),
    ownBranch,
    planned: (id) => threadMoves.planned(id),
    ready: { take: (thread, folder, repository) => readiness.take(thread, folder, repository) },
    archived: (id) => archived.has(id),
    // As the host's `folderRepository` reads one: the origin's repository, and the branch there its branch tracks.
    repositoryOf: async (folder) => {
      const upstream = await git.output(folder, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")
      return { url: "https://github.com/octocat/Hello-World", ...upstream.startsWith("origin/") && { branch: upstream.slice("origin/".length) } }
    },
    sendRecords: async (_link, paths) => paths.map(() => ({ harness: "claude", nativeId: "n", versions: 1, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1, holdings: {} })),
    cloud: {
      adopt: async () => {},
      callThread: async (_threadId, channel) => {
        // A cloud slow to start the machine: the move waits for it, past the Mac's deadline.
        if (channel === "mako:move-ready" && options.readyNever) await new Promise(() => undefined)
        return encodeRuntimeValue({ ok: true })
      },
    },
    live: {
      handOff: (id) => world.live.handOff(id),
      continueTurn: (id, input) => void world.live.continueTurn(id, input),
      waitingPrompts: (id) => world.live.waitingPrompts(id),
      carried: (id, requestIds, to) => world.live.carried(id, requestIds, to),
    },
    remembered: () => null,
    step: (conversation, _move, step) => void steps.push({ conversation, kind: step.kind }),
    newCloudThread: () => `t-${randomBytes(8).toString("hex")}`,
  })
  // Threads at work kept ready, as the host keeps them while handing off on sleep is on: a round runs when a test asks.
  const working = () => workingThreads({ live: world.live, threads: world.store, cloud: () => false })
  const readiness: CloudReadiness = new CloudReadiness({
    file: join(base, "cloud", "ready.json"),
    git,
    scratch: join(base, "cloud", "ready"),
    account: () => account,
    enabled: async () => true,
    working,
    leaving: (thread) => cloudMoves.leaving(thread),
    plan: (id) => cloudMoves.readyPlan(id),
    sendRecords: async (_link, paths) => paths.map(() => ({ harness: "claude", nativeId: "n", versions: 1, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1, holdings: {} })),
    newCloudThread: () => `t-${randomBytes(8).toString("hex")}`,
  })
  const handOffs = new CloudHandOffs({
    file: join(base, "cloud", "handoff.json"),
    working: () => workingThreads({ live: world.live, threads: world.store, cloud: () => false }),
    moves: cloudMoves,
    unavailable: async () => undefined,
    changed: () => {},
  })

  /** A Thread with one answer, its conversation on `harness` in the project folder. */
  const thread = async (harness: string, title: string) => {
    const conversation = randomUUID()
    await world.live.start(harness, project, { conversationId: conversation, title })
    world.say(conversation, `Look around ${title}`)
    await until(`${title}'s first answer`, () => world.live.snapshot(conversation)?.requests.at(-1)?.status === "completed")
    return conversation
  }
  /** Starts a long turn in `conversation` and waits until it runs. */
  const startWork = async (conversation: string) => {
    const request = world.say(conversation, LONG)
    await until("the turn to run", () => world.live.snapshot(conversation)?.session.status === "running")
    return request
  }
  const close = async () => {
    await world.close()
    await tracker.close?.()
  }
  return { base, project, world, worktrees, threadMoves, ownBranch, cloudMoves, readiness, handOffs, moved, made, checkpoints, steps, personWrites, agentWrites, thread, working: startWork, close }
}

type Host = Awaited<ReturnType<typeof host>>
/** The two Threads at work, by their conversations. */
const conversations = (work: { inProject: string; inWorktree: string }): string[] => [work.inProject, work.inWorktree]

/**
 * Two Threads at work: `inProject`, mid-turn in the project folder, its agent having written `own.ts` there, beside
 * the person's own edit of `person.ts`; and `inWorktree`, on its own branch already, mid-turn there.
 */
async function atWork(h: Host) {
  const inWorktree = await h.thread("claude", "Worktree")
  assert.equal(await h.ownBranch(inWorktree), inWorktree)
  const inProject = await h.thread("codex", "Project")
  await h.personWrites(join(h.project, "person.ts"), "export const person = 2 // the person's, uncommitted\n")
  const turns = { inProject: await h.working(inProject), inWorktree: await h.working(inWorktree) }
  await h.agentWrites(inProject, turns.inProject, join(h.project, "own.ts"), "export const own = 1 // the agent's\n")
  return { inProject, inWorktree, turns }
}

/**
 * A round of keeping Threads at work ready, as the host runs one every half minute: each stands by in the cloud, the one
 * in the project folder at the worktree its move would make, named with nothing made of it and no checkout sent ahead
 * of it, since there is none yet.
 */
async function keptReady(h: Host, work: Awaited<ReturnType<typeof atWork>>) {
  const branches = sh(h.project, "branch", "--list", "mako/*")
  const planned = await h.threadMoves.planned(work.inProject)
  assert.ok(planned, "the project folder's Thread names the worktree its move would make")
  await h.readiness.refresh()
  assert.equal(sh(h.project, "branch", "--list", "mako/*"), branches, "naming it made no branch")
  assert.ok(!existsSync(planned.folder), "and no folder")
  const inProject = h.made.find((each) => each.standby && each.folder === planned.folder)
  assert.ok(inProject, "a cloud Thread stands by at that worktree")
  assert.ok(!h.checkpoints.includes(inProject.threadId), "with no checkout sent ahead of it")
  const inWorktree = h.made.find((each) => each.standby && each.folder === h.worktrees.threadCheckout(work.inWorktree)?.path)
  assert.ok(inWorktree && h.checkpoints.includes(inWorktree.threadId), "the Thread in its own worktree stands by too, its checkout sent ahead")
  return { planned, standing: [inProject.threadId, inWorktree.threadId] }
}

/** Both Threads went to the cloud: their paused turns go on there, never here, and only its own changes went with the one from the project folder. */
async function wentToTheCloud(h: Host, way: string, work: Awaited<ReturnType<typeof atWork>>, ready?: Awaited<ReturnType<typeof keptReady>>): Promise<void> {
  await until(`${way}: both moves claimed`, () => [...h.moved.values()].filter((each) => each.answer?.kind === "claimed").length === 2)
  const continued = [...h.moved.values()].flatMap((each) => each.continued)
  assert.deepEqual(continued.sort(), [work.turns.inProject, work.turns.inWorktree].sort(), `${way}: each paused turn goes on in the cloud`)
  for (const each of h.moved.values()) assert.ok(each.channels.indexOf("mako:move-arrive") < each.channels.indexOf("mako:live-continue-turn"), `${way}: after the Thread arrives`)
  await until(`${way}: both Threads the cloud's`, () => [work.inProject, work.inWorktree].every((id) => h.world.store.execution(SessionIdSchema.parse(h.world.store.journalPlacement(id)!.session))?.state === "elsewhere"))
  if (ready) {
    assert.deepEqual([...h.moved.values()].map((each) => each.cloudThread).sort(), [...ready.standing].sort(), `${way}: each move took the cloud Thread kept ready for it: ${JSON.stringify({ made: h.made, folders: [h.worktrees.threadCheckout(work.inProject)?.path, h.worktrees.threadCheckout(work.inWorktree)?.path] })}`)
    assert.equal(h.made.filter((each) => !each.standby && !ready.standing.includes(each.threadId)).length, 0, `${way}: and made none of its own`)
  }
  const moved = h.world.live.snapshot(work.inProject)!.session.cwd
  if (ready) assert.equal(h.worktrees.threadCheckout(work.inProject)?.path, ready.planned.folder, `${way}: the worktree it went onto is the one named ahead`)
  assert.notEqual(moved, h.project, `${way}: the Thread from the project folder works on its own branch now`)
  assert.equal(h.worktrees.threadCheckout(work.inProject)?.path, moved, `${way}: in its own worktree`)
  assert.notEqual(sh(moved, "branch", "--show-current"), "main")
  assert.equal(readFileSync(join(moved, "own.ts"), "utf8"), "export const own = 1 // the agent's\n", `${way}: its own change went with it`)
  assert.ok(!existsSync(join(h.project, "own.ts")), `${way}: and left the project folder`)
  assert.equal(readFileSync(join(h.project, "person.ts"), "utf8"), "export const person = 2 // the person's, uncommitted\n", `${way}: the person's change stays in the project folder`)
  assert.equal(readFileSync(join(moved, "person.ts"), "utf8"), "export const person = 1\n", `${way}: and never went with the Thread`)
  assert.equal(sh(h.project, "status", "--porcelain"), "M person.ts", `${way}: the project folder holds the person's work alone`)
  assert.ok(!h.world.prompts.some((prompt) => prompt.text.includes("Continue") && conversations(work).includes(prompt.conversation)), `${way}: no turn went on here`)
}

/** A stand-in for the native sleep watch: says the Mac will sleep, once, and exits once it's let go. */
function sleepWatch(dir: string): string {
  const helper = join(dir, "sleep-watch.mjs")
  writeFileSync(helper, `
    import { createInterface } from "node:readline"
    console.log("ready")
    createInterface({ input: process.stdin }).on("line", (line) => {
      if (line.startsWith("allow ")) { console.log("slept " + line.slice(6) + " answer"); process.exit(0) }
    })
    console.log("will-sleep 1")
  `)
  return helper
}

/** The Mac sleeps: the watch hears it, the host hands off, and the watch lets it sleep. */
async function sleeps(h: Host, holdMs: number): Promise<void> {
  const helper = sleepWatch(h.base)
  await new Promise<void>((resolve) => {
    const watch = new SleepHandOff({
      helper: async () => helper,
      enabled: async () => true,
      handOff: async (handOff, releaseBy) => void (await h.handOffs.handOff(handOff, "sleep", releaseBy)),
      woke: () => {},
      holdMs,
      spawn: (path, args) => {
        const child = spawn(process.execPath, [path, ...args], { stdio: ["pipe", "pipe", "pipe"] })
        child.once("exit", () => resolve())
        return child
      },
    })
    void watch.refresh()
  })
}

try {
  // As this Mac sleeps.
  {
    const h = await host("sleep")
    const work = await atWork(h)
    const ready = await keptReady(h, work)
    await sleeps(h, 20_000)
    await wentToTheCloud(h, "sleep", work, ready)
    await h.close()
  }

  // As this Mac shuts down, within the shutdown's own hold: the cloud hears it go quiet only once the handoff answered.
  {
    const h = await host("shutdown")
    const work = await atWork(h)
    const ready = await keptReady(h, work)
    const quiet: string[] = []
    await machineLeaving("shutdown", { handOffs: h.handOffs, enabled: async () => true, quiet: (why) => void quiet.push(`${why} after ${[...h.moved.values()].length} moves`) })
    assert.deepEqual(quiet, ["quit after 2 moves"], "quiet once both Threads were handed over")
    await wentToTheCloud(h, "shutdown", work, ready)
    await h.close()
  }

  // Out of time, the cloud slow to ready its machine: both stay, their turns paused, so they read idle while the Mac
  // is off, for Continue in the cloud from another device; once this Mac hears its account, they go on here.
  {
    const h = await host("out-of-time", { readyNever: true })
    const work = await atWork(h)
    await sleeps(h, 9_000)
    for (const id of [work.inProject, work.inWorktree]) {
      const snapshot = h.world.live.snapshot(id)!
      assert.notEqual(snapshot.session.status, "running", "paused, not at work as the Mac sleeps")
      assert.equal(h.world.store.execution(SessionIdSchema.parse(h.world.store.journalPlacement(id)!.session))?.state, "here")
    }
    assert.ok(workingThreads({ live: h.world.live, threads: h.world.store, cloud: () => false }).length === 0, "nothing reads at work")
    assert.notEqual(h.world.live.snapshot(work.inProject)!.session.cwd, h.project, "the Thread from the project folder went onto its own branch first, as Continue in the cloud needs")
    const before = h.world.prompts.length
    await h.cloudMoves.unpark()
    await until("both turns to go on here", () => h.world.prompts.slice(before).filter((prompt) => conversations(work).includes(prompt.conversation)).length === 2)
    await h.close()
  }
  // A project folder of two repositories: named ahead, its Thread's worktree is the first repository's, by path, where the
  // move then makes it; a folder of one repository alone inside isn't named, its worktree being laid out otherwise.
  {
    const h = await host("two")
    const folder = join(h.base, "two")
    for (const name of ["web", "api"]) {
      const remote = join(h.base, `${name}.git`)
      sh(h.base, "init", "--bare", "--quiet", remote)
      sh(h.base, "clone", "--quiet", remote, join(folder, name))
      writeFileSync(join(folder, name, "a.txt"), `${name}\n`)
      sh(join(folder, name), "add", ".")
      sh(join(folder, name), "commit", "--quiet", "-m", "base")
    }
    const planned = await h.worktrees.plannedCheckout(randomUUID(), folder, "Both sides")
    assert.ok(planned && !existsSync(planned.folder), "named, with nothing made")
    assert.equal(planned.repository, realpathSync(join(folder, "api")), "the first repository by its worktree's path")
    assert.deepEqual([...planned.repositories].sort(), [realpathSync(join(folder, "api")), realpathSync(join(folder, "web"))], "both repositories, for each one's own checkpoint")
    await h.worktrees.prepareFork(randomUUID(), randomUUID(), folder, "Both sides")
    assert.ok(existsSync(join(planned.folder, ".git")), "the move makes that very worktree")
    assert.equal(sh(planned.folder, "symbolic-ref", "--short", "HEAD"), planned.branch, "on the branch named ahead, which a checkpoint carries")
    mkdirSync(join(h.base, "one"))
    sh(h.base, "clone", "--quiet", join(h.base, "web.git"), join(h.base, "one", "web"))
    assert.equal(await h.worktrees.plannedCheckout(randomUUID(), join(h.base, "one"), "Alone"), undefined)
    await h.close()
  }
  console.log("PASS: as this Mac sleeps and as it shuts down, a Thread at work in the project folder goes onto its own branch as itself with only its own changes and on to the cloud, as one in its own worktree does, each paused turn going on there; out of time, both wait paused, idle for Continue in the cloud, and go on here once the Mac is back")
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
