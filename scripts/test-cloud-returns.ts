import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import type { ReturnDeparture, ReturnState } from "@mako/protocol/moves"
import type { ReceivedRecords } from "@mako/sessions/record-sync"
import { CloudReturns, type CloudReturnsOptions } from "@mako/host/conversations/cloud-returns"
import { CloudFollow } from "@mako/host/conversations/cloud-follow"
import { CloudWorktrees } from "@mako/host/conversations/cloud-worktrees"
import { CloudArchives } from "@mako/host/conversations/cloud-archives"
import type { CloudArchiveStep } from "@mako/host/contracts/thread-lifecycle"
import type { ArchivedThread } from "@mako/protocol/thread-listing"
import { cloudRuntimeOf, type MovePlanSchema } from "@mako/host/conversations/cloud-moves"
import type { ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import { encodeRuntimeValue, type EncodedValue } from "@mako/host/contracts/runtime-value"
import { MoveIdSchema, type MoveId } from "@mako/host/contracts/thread-execution"
import { SessionIdSchema } from "@mako/host/contracts/thread-identity"
import { ThreadStore, type JournalFacts } from "@mako/host/threads/store"
import { captureMoveCheckpoint } from "@mako/host/workspaces/index"
import { captureCarry } from "@mako/host/workspaces/move-carry"
import type { MoveCheckpoint, MoveOutsideFile } from "@mako/protocol/moves"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import { z } from "zod"

/**
 * A Thread of this Mac's coming back from the cloud (`CloudReturns`), against the real Thread store and real
 * checkouts, with the gateway and the machine as stand-ins that keep the gateway's rule (one record per return, which
 * only goes forward). The machine's checkout replaces this Mac's worktree and the Thread runs here again, one
 * generation on; a machine that can't pack cancels it, and the machine is told to keep the Thread; records this Mac
 * can't take put the worktree back exactly and give the Thread back; an answer this Mac can't hear leaves it
 * unsettled until the next host settles it; and asked again, a return answers how it went. What this Mac must have is
 * made sure of before the cloud lets go: a worktree whose project is gone is refused with nothing asked of the cloud,
 * one whose folder went or whose project moved is made ready again, and one that can't be kept cancels the return.
 * The races: an edit made while the checkout comes down is merged in, and a follow the way back overtook lays nothing.
 * A forged carry writes nothing this Mac never sent; a file it can't write back is named and the rest still come.
 */
/** What the machine is asked to pack: the conversations going back. */
const DepartAskSchema = z.object({ conversations: z.array(z.string()) }).loose()
const root = mkdtempSync(join(tmpdir(), "mako-cloud-returns-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
let clock = 1_000

/** The gateway's returns, by its rules, and the machine's departure and stay. */
class Cloud {
  readonly records = new Map<string, ReturnState>()
  readonly calls: Array<{ channel: string; args: readonly unknown[] }> = []
  readonly checkpoints = new Map<string, string>()
  /** The sessions pulled ahead into Mako's record store as the checkout came down, by each return. */
  readonly ahead: string[][] = []
  /** Set to make pulling ahead fail: the restore pulls it all instead. */
  aheadFails = false
  /** The machine's departure: what it packs, or why it can't. */
  depart: () => Promise<ReturnDeparture> = async () => { throw new Error("no departure set") }
  /** Set to refuse the next archive's beginning, as the gateway does a Thread at work: nothing is begun. */
  refuseBegin: string | undefined
  /** Run as a checkpoint is read, before it comes down: what happens here meanwhile. */
  reading: ((sha256: string) => Promise<void>) | undefined
  unreachable = 0
  step(move: string, next: (record: ReturnState | undefined) => ReturnState | "past"): ReturnState {
    if (this.unreachable > 0) {
      this.unreachable -= 1
      throw new Error("the network is down")
    }
    const record = this.records.get(move)
    const after = next(record)
    if (after === "past") {
      if (!record) throw new Error("This return wasn't begun")
      return record
    }
    this.records.set(move, after)
    return after
  }
}

/** A return's mark of the archive, carried along as the gateway does (`returns.ts`). */
const mark = (record: ReturnState): Pick<ReturnState, "to" | "by"> => {
  const marked: Pick<ReturnState, "to" | "by"> = {}
  if (record.to === "archive") marked.to = "archive"
  if (record.to === "archive" && record.by) marked.by = record.by
  return marked
}

/** The repository a Thread's move recorded, as GitHub names it. */
const REPOSITORY = "https://github.com/octocat/Hello-World"

/**
 * `worktree`: the Thread works in a worktree of a project, as a person's Thread does (the project at `project`, the
 * worktree on `mako/fix`), and the machine's commit wasn't pushed, so its checkpoint carries it and nothing here asks
 * the remote for it. Otherwise the checkout is a clone of its own.
 */
function setup(name: string, options: { worktree?: boolean } = {}) {
  const folder = join(root, name)
  const remote = join(folder, "remote.git")
  const project = join(folder, "Users", "ada", "project")
  const checkout = join(folder, "Users", "ada", "worktrees", "fix")
  const machine = join(folder, "machine", "fix")
  sh(root, "init", "--bare", "--quiet", remote)
  const main = options.worktree ? project : checkout
  sh(root, "clone", "--quiet", remote, main)
  writeFileSync(join(main, "a.txt"), "one\n")
  sh(main, "add", ".")
  sh(main, "commit", "--quiet", "-m", "base")
  sh(main, "push", "--quiet", "origin", "main")
  if (options.worktree) sh(project, "worktree", "add", "--quiet", "-b", "mako/fix", checkout)
  writeFileSync(join(checkout, "a.txt"), "one, as it left this Mac\n")
  // The machine's clone went on: a commit of the agent's, pushed, and a file it left.
  sh(root, "clone", "--quiet", remote, machine)
  if (options.worktree) sh(machine, "checkout", "--quiet", "-b", "mako/fix")
  writeFileSync(join(machine, "a.txt"), "one, changed in the cloud\n")
  sh(machine, "commit", "--quiet", "-am", "in the cloud")
  if (!options.worktree) sh(machine, "push", "--quiet", "origin", "main")
  writeFileSync(join(machine, "b.txt"), "left by the agent\n")

  const threads = new ThreadStore(join(folder, "threads.sqlite"), { now: () => clock++, realPath: (path) => path })
  const conversation = randomUUID()
  const facts: JournalFacts = { conversationId: conversation, createdAt: clock++, harness: "codex", bindings: [{ provider: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }] }
  const placed = threads.registerJournal(facts, threads.person())
  // The move that took it there, as this Mac's store and its plan keep it.
  const cloudThread = `t-${name.padEnd(16, "0").slice(0, 16).replace(/[^0-9a-f]/g, "a")}`
  const forwardMove = MoveIdSchema.parse(randomUUID())
  const runtime = cloudRuntimeOf(cloudThread)
  threads.beginMove({ move: forwardMove, thread: placed.thread, target: { kind: "cloud", runtime }, actor: threads.person() })
  const handoff = threads.release({ operationId: randomUUID(), move: forwardMove, actor: threads.person() })
  threads.confirm({ operationId: randomUUID(), receipt: { move: forwardMove, owner: { kind: "cloud", runtime }, sessions: handoff.sessions.map((session) => ({ id: session.id, generation: session.generation + 1 })) }, actor: threads.person() })
  if (options.worktree) threads.attachWorktree({ path: checkout, thread: placed.thread, repoRoot: project, project, branch: "mako/fix", base: sh(project, "rev-parse", "HEAD") })
  const plan: z.input<typeof MovePlanSchema> = {
    move: forwardMove, thread: placed.thread, asked: conversation, cloudThread, folder: checkout, repository: { url: REPOSITORY },
    sessions: [{ session: placed.session, conversationId: conversation, harness: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }],
    phase: "started", handoff, began: 1, timings: {},
  }
  mkdirSync(join(folder, "moves"), { recursive: true })
  writeFileSync(join(folder, "moves", `${forwardMove}.json`), JSON.stringify(plan))

  const cloud = new Cloud()
  const device = randomUUID()
  const steps: ThreadReturnStep[] = []
  const released: string[] = []
  const captured: Array<[string, string]> = []
  /** The cloud Thread's conversations, as this Mac follows them: the one that moved, and any begun there. */
  const there: Array<{ conversationId: string; harness: string; nativeId: string | undefined }> = [{ conversationId: conversation, harness: "codex", nativeId: "n-1" }]
  /** What the machine knows of each conversation it runs: the native session it started there. */
  const nativeThere = new Map<string, string>([[conversation, "n-1"]])
  let restored: ReceivedRecords["restored"] | undefined
  let receiveFails: Error | undefined
  /** Set to make taking the records never answer, as a host that stops there; called as it's asked. */
  let receiveHangs: (() => void) | undefined
  /** Set to make the claim here fail that many times: this Mac's own work, after the cloud let go. */
  let claimFails = 0
  const worktrees = new ThreadWorktreeService(git, join(folder, "Users", "ada", "mako-worktrees"), threads)
  cloud.depart = async () => {
    const scratch = mkdtempSync(join(folder, "pack-"))
    const { checkpoint, file } = await captureMoveCheckpoint(git, machine, scratch)
    cloud.checkpoints.set(checkpoint.sha256, file)
    const asked = DepartAskSchema.parse(cloud.calls.findLast((call) => call.channel === "mako:move-depart")?.args[0]).conversations
    // What the machine packs, by what it knows: each conversation's native session there.
    return { checkpoint, sessions: asked.map((id) => ({ harness: there.find((each) => each.conversationId === id)?.harness ?? "", nativeId: nativeThere.get(id) ?? "" })).map((each) => ({ ...each, holdings: { [`${each.harness}:${each.nativeId}.jsonl`]: 5 } })) }
  }
  const unused = () => Promise.reject(new Error("not in this test"))
  /** The one owner of the worktree's writes, as the host makes it: the way back's and the follow's. */
  const owner = new CloudWorktrees()
  /** The machine, through its Thread: it packs, takes the Thread back, and says what it runs. */
  const callThread = async (_threadId: string, channel: string, args: readonly unknown[]): Promise<EncodedValue> => {
    cloud.calls.push({ channel, args })
    if (channel === "mako:move-depart") return encodeRuntimeValue(await cloud.depart())
    if (channel === "mako:move-stay") return encodeRuntimeValue({ stayed: true })
    // The machine's own word on a conversation it runs: the native session it started, or none.
    if (channel === "mako:live-snapshot") return encodeRuntimeValue({ session: { nativeId: nativeThere.get(String(args[0])) ?? null } })
    // The machine's checkout as it stands, for the worktree here to follow.
    if (channel === "mako:move-follow") {
      const { checkpoint, file } = await captureMoveCheckpoint(git, machine, mkdtempSync(join(folder, "there-")))
      cloud.checkpoints.set(checkpoint.sha256, file)
      return encodeRuntimeValue({ repositories: [{ path: checkout, checkpoint }] })
    }
    throw new Error(`no ${channel} in this test`)
  }
  const account: ReturnType<CloudReturnsOptions["account"]> = {
    token: async () => "token", gateway: () => new URL("https://gateway.test"), id: async () => "acct",
    session: () => { throw new Error("no session in this test") },
    deviceId: async () => device,
    createThread: unused, askBases: unused, sendCheckpoint: unused, handOverMove: unused, refuseMove: unused, moveAnswer: unused,
    threadRecords: async (threadId) => ({ id: threadId, base: `https://gateway.test/v1/threads/${threadId}/records`, authorization: "Bearer token" }),
    deviceRecords: async (deviceId) => ({ id: deviceId, base: `https://gateway.test/v1/devices/${deviceId}/records`, authorization: "Bearer token" }),
    deviceOriginals: async (deviceId) => ({ id: deviceId, base: `https://gateway.test/v1/devices/${deviceId}/originals`, authorization: "Bearer token" }),
    readCheckpoint: async (_threadId, sha256, file) => {
      await cloud.reading?.(sha256)
      copyFileSync(cloud.checkpoints.get(sha256) ?? "/missing", file)
    },
    beginReturn: async (_threadId, move, to) => {
      const refused = cloud.refuseBegin
      cloud.refuseBegin = undefined
      if (refused) throw new Error(refused)
      return cloud.step(move, (record) => record ?? { phase: "returning", move, at: clock++, ...to && { to, by: device } })
    },
    releaseReturn: async (_threadId, move, departure) => cloud.step(move, (record) => record?.phase === "returning" ? { phase: "released", move, at: clock++, departure, ...mark(record) } : "past"),
    cancelReturn: async (_threadId, move, reason) => cloud.step(move, (record) => record?.phase === "returning" ? { phase: "cancelled", move, at: clock++, reason, ...mark(record) } : "past"),
    giveBackReturn: async (_threadId, move, reason) => cloud.step(move, (record) => record?.phase === "released" ? { phase: "given-back", move, at: clock++, reason, departure: record.departure, ...mark(record) } : "past"),
    finishReturn: async (_threadId, move) => cloud.step(move, (record) => (record?.phase === "released" && record.to !== "archive") || (record?.phase === "archived" && record.departure) ? { phase: "returned", move, at: clock++, departure: record.departure!, ...mark(record) } : "past"),
    archiveReturn: async (_threadId, move) => cloud.step(move, (record) => (record?.phase === "released" || record?.phase === "returning") && record.to === "archive" ? { phase: "archived", move, at: clock++, to: "archive", ...record.phase === "released" && { departure: record.departure }, ...record.by && { by: record.by } } : "past"),
    returnState: async (_threadId, move) => cloud.records.get(move),
    wake: () => undefined, stop: () => undefined,
  }
  const make = () => new CloudReturns({
    folder: join(folder, "returns"),
    moves: join(folder, "moves"),
    git,
    account: () => account,
    threads: () => threads,
    claim: (input) => {
      if (claimFails > 0) {
        claimFails -= 1
        throw new Error("database is locked")
      }
      return threads.claim(input)
    },
    ready: (input) => worktrees.readyForReturn(input),
    updateOffer: (harness) => ({ kind: "update", runtimeId: harness, label: harness }),
    stageRecords: async (_link, sessions) => {
      if (cloud.aheadFails) throw new Error("the network dropped")
      cloud.ahead.push(sessions.map((session) => session.nativeId))
      return sessions.map((session) => ({ harness: session.harness, nativeId: session.nativeId, versions: 1, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1 }))
    },
    receiveRecords: async (_link, sessions) => receiveHangs ? (receiveHangs(), new Promise<never>(() => undefined)) : receiveFails ? Promise.reject(receiveFails) : sessions.map((session) => ({ harness: session.harness, nativeId: session.nativeId, pulled: { versions: 1, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1 }, restored: restored ?? { kind: "restored", path: `/${session.harness}/${session.nativeId}.jsonl`, files: 1, rows: 0, ms: 1 } })),
    cloud: {
      callThread,
      releaseThread: async (threadId) => {
        const ids = there.map((each) => each.conversationId)
        released.push(threadId)
        return ids
      },
      threadConversations: () => there,
    },
    capture: async (conversationId, path) => void captured.push([conversationId, path]),
    step: (_conversationId, _move, step) => steps.push(step),
    worktrees: owner,
  })
  const state = () => threads.execution(placed.session)
  /** The forward move's plan, as this Mac keeps it, changed by `change`. */
  const forwardFile = join(folder, "moves", `${forwardMove}.json`)
  const forward = (change: (plan: z.input<typeof MovePlanSchema>) => z.input<typeof MovePlanSchema>) => {
    const was: z.input<typeof MovePlanSchema> = JSON.parse(readFileSync(forwardFile, "utf8"))
    writeFileSync(forwardFile, JSON.stringify(change(was)))
  }
  /** What the forward move sent, which the cloud keeps by its hash: the worktree as it is now. */
  const sentNow = async (): Promise<MoveCheckpoint> => {
    const sent = await captureMoveCheckpoint(git, checkout, mkdtempSync(join(folder, "sent-")))
    cloud.checkpoints.set(sent.checkpoint.sha256, sent.file)
    forward((plan) => ({ ...plan, checkpoint: sent.checkpoint }))
    return sent.checkpoint
  }
  const files = () => [readFileSync(join(checkout, "a.txt"), "utf8"), sh(checkout, "status", "--short")]
  /** A `+` tab of the Thread's, begun in the cloud as the router records it; without a harness, one never sent. */
  const tab = (harness?: string, nativeId?: string) => {
    const made = threads.createSession({ operationId: randomUUID(), thread: placed.thread, actor: threads.person() })
    if (!harness) return { session: made.session, conversationId: undefined }
    const conversationId = randomUUID()
    threads.adoptElsewhere({ operationId: randomUUID(), conversationId, session: made.session, actor: threads.person() })
    there.push({ conversationId, harness, nativeId })
    if (nativeId) nativeThere.set(conversationId, nativeId)
    return { session: made.session, conversationId }
  }
  /**
   * A fork in the cloud of the conversation that moved, into the Session the machine named. `heardHere`: whether this
   * Mac heard its native session; a fork names it only once its first turn runs, which this Mac may not have heard.
   */
  const fork = (harness: string, nativeId: string, heardHere = true) => {
    const conversationId = randomUUID()
    const placedFork = threads.adoptElsewhere({ operationId: randomUUID(), conversationId, forkOf: conversation, forkSession: SessionIdSchema.parse(randomUUID()), actor: threads.person() })
    there.push({ conversationId, harness, nativeId: heardHere ? nativeId : undefined })
    nativeThere.set(conversationId, nativeId)
    return { session: placedFork.session, conversationId }
  }
  /** Archives the cloud Thread from this Mac, as the router lists it: its conversations that started there, at its folder. */
  const archiveSteps: CloudArchiveStep[] = []
  const archives = () => new CloudArchives({
    folder: join(folder, "archives"),
    account: () => account,
    cloud: {
      callThread,
      archiveInputs: () => ({ conversations: there.filter((each) => each.nativeId).map((each) => each.conversationId), folder: checkout }),
    },
    step: (step) => archiveSteps.push(step),
  })
  return {
    returns: make(), fresh: make, archives, archiveSteps, account, there, cloud, conversation, checkout, project, remote, folder, steps, released, captured, state, files, device, cloudThread, threads, thread: placed.thread, session: placed.session, tab, fork, handoff,
    owner, machine, callThread, forward, sentNow,
    setRestored: (next: ReceivedRecords["restored"]) => (restored = next),
    failReceive: (error: Error) => (receiveFails = error),
    hangReceive: (asked: (() => void) | undefined) => (receiveHangs = asked),
    failClaim: (times: number) => (claimFails = times),
  }
}

const move = (): MoveId => MoveIdSchema.parse(randomUUID())

try {
  // The whole way: begun, packed, released, laid over this Mac's worktree, claimed here, done.
  {
    const s = setup("back")
    assert.equal(s.state()?.state, "elsewhere")
    const id = move()
    // A call for the Thread while it's on its way waits for the return (`CloudConversations`), and finds it here after.
    const packs = s.cloud.depart
    let waited: Promise<unknown> | undefined
    s.cloud.depart = async () => {
      waited = s.returns.returning(s.cloudThread)?.then(() => [s.state()?.state, s.released, s.returns.returning(s.cloudThread)])
      return packs()
    }
    const outcome = await s.returns.bringBack(s.conversation, id)
    assert.deepEqual(outcome, { kind: "back" })
    assert.deepEqual(await waited, ["here", [s.cloudThread], undefined], "settled once it's here and answered here, and over")
    assert.deepEqual(s.steps.map((step) => step.kind), ["packing", "bringing", "back"])
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 5], "released (2), the cloud's (3), released there (4), claimed here (5)")
    assert.equal(s.files()[0], "one, changed in the cloud\n", "the machine's checkout, over this Mac's")
    assert.match(s.files()[1] ?? "", /b\.txt/, "with the file the agent left")
    assert.deepEqual(s.released, [s.cloudThread], "no longer answered by the cloud")
    assert.deepEqual(s.captured, [], "the conversation that moved has its journal here already")
    assert.equal(s.cloud.records.get(id)?.phase, "returned", "the cloud ends the machine")
    const depart = s.cloud.calls.find((call) => call.channel === "mako:move-depart")
    assert.deepEqual(depart?.args, [{ move: id, folder: s.checkout, conversations: [s.conversation], device: s.device }], "released on the machine toward this Mac")
    assert.ok(!s.cloud.calls.some((call) => call.channel === "mako:move-stay"))
    assert.deepEqual(await s.returns.bringBack(s.conversation, id), { kind: "back" }, "asked again, the same")
    assert.deepEqual(s.cloud.ahead, [["n-1"]], "its records came down beside the checkout, once")
  }

  // The person changed the worktree here while the Thread was away: their changes are merged with the cloud's, never
  // written over. The file both changed holds Git's markers; the window hears what merged and what conflicts, and the
  // agent hears it once, on its next turn.
  {
    const s = setup("edited-here")
    // What the forward move sent: the worktree as it left, which the cloud keeps by its hash.
    const sent = await captureMoveCheckpoint(git, s.checkout, mkdtempSync(join(s.folder, "sent-")))
    s.cloud.checkpoints.set(sent.checkpoint.sha256, sent.file)
    const forwardFile = join(s.folder, "moves", readdirSync(join(s.folder, "moves")).find((name) => name.endsWith(".json")) ?? "")
    writeFileSync(forwardFile, JSON.stringify({ ...JSON.parse(readFileSync(forwardFile, "utf8")), checkpoint: sent.checkpoint }))
    writeFileSync(join(s.checkout, "a.txt"), "one, changed by the person here\n")
    writeFileSync(join(s.checkout, "c.txt"), "the person's own\n")
    const outcome = await s.returns.bringBack(s.conversation, move())
    assert.deepEqual(outcome, { kind: "back", landed: { merged: ["a.txt", "c.txt"], conflicts: ["a.txt"], outside: { placed: [], removed: [], waiting: [] } } })
    assert.deepEqual(s.steps.at(-1), { kind: "back", conversations: [s.conversation], landed: outcome.kind === "back" ? outcome.landed : undefined })
    assert.equal(readFileSync(join(s.checkout, "c.txt"), "utf8"), "the person's own\n", "the person's new file stays")
    assert.equal(readFileSync(join(s.checkout, "b.txt"), "utf8"), "left by the agent\n", "the cloud's file came")
    assert.match(readFileSync(join(s.checkout, "a.txt"), "utf8"), /<<<<<<< mako\/merge\/this-mac\none, changed by the person here\n=======\none, changed in the cloud\n>>>>>>> mako\/merge\/cloud/)
    const told = s.returns.notices(s.conversation)
    assert.equal(told.length, 1)
    assert.match(told[0] ?? "", /changed c\.txt|kept their changes beside yours: c\.txt/)
    assert.match(told[0] ?? "", /both changed a\.txt: it holds Git's conflict markers/)
    assert.deepEqual(s.returns.notices(s.conversation), [], "told once")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const restarted = s.fresh()
    await restarted.settle()
    assert.deepEqual(restarted.notices(s.conversation), [], "and not again after a restart")
  }

  // Records that can't come down ahead: the restore pulls them all, and the Thread comes back the same.
  {
    const s = setup("ahead-fails")
    s.cloud.aheadFails = true
    assert.deepEqual(await s.returns.bringBack(s.conversation, move()), { kind: "back" })
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 5])
  }

  // The person edits while the machine's checkout comes down (or while a host stopped after the release waits to
  // resume): the worktree is kept again right before the machine's is laid, so their edit is merged in, never cleared.
  {
    const s = setup("edited-coming")
    await s.sentNow()
    s.cloud.reading = async () => {
      s.cloud.reading = undefined
      writeFileSync(join(s.checkout, "d.txt"), "written as it came down\n")
    }
    const outcome = await s.returns.bringBack(s.conversation, move())
    assert.equal(outcome.kind, "back")
    assert.equal(readFileSync(join(s.checkout, "d.txt"), "utf8"), "written as it came down\n", "kept, not cleared")
    assert.deepEqual(outcome.kind === "back" && outcome.landed?.merged, ["d.txt"], "and said as merged")
    assert.equal(s.files()[0], "one, changed in the cloud\n", "beside the cloud's work")
    assert.deepEqual(readdirSync(join(s.folder, "returns")).filter((name) => !name.endsWith(".json")), [], "no copy left once it's back")
  }

  // A host that stops after laying the machine's checkout, before it's recorded taken: the next one takes the worktree
  // up from the copy kept before, never keeping again what's partly the cloud's as the person's.
  {
    const s = setup("stopped-laying")
    await s.sentNow()
    writeFileSync(join(s.checkout, "c.txt"), "the person's own\n")
    let asked = () => {}
    const receiving = new Promise<void>((resolve) => (asked = resolve))
    s.hangReceive(asked)
    const id = move()
    void s.returns.bringBack(s.conversation, id)
    await receiving
    s.hangReceive(undefined)
    await s.fresh().settle()
    assert.equal(s.cloud.records.get(id)?.phase, "returned")
    const landed = z.object({ landed: z.object({ merged: z.array(z.string()), mine: z.string().optional() }) }).parse(JSON.parse(readFileSync(join(s.folder, "returns", `${id}.json`), "utf8"))).landed
    assert.deepEqual(landed, { merged: ["c.txt"] }, "only the person's edit is theirs, and no branch of the cloud's commits as theirs")
    assert.equal(readFileSync(join(s.checkout, "c.txt"), "utf8"), "the person's own\n")
    assert.equal(s.files()[0], "one, changed in the cloud\n")
  }

  // A follow that began before Bring back, its download slow: the way back overtakes it and owns the worktree, so the
  // follow lays nothing, neither between the way back's keeping and laying nor over the finished worktree.
  {
    const s = setup("follow-race")
    await s.sentNow()
    let heard = () => {}
    const asked = new Promise<void>((resolve) => (heard = resolve))
    let release = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    const follow = new CloudFollow({
      folder: join(s.folder, "follow"),
      moves: join(s.folder, "moves"),
      git,
      readCheckpoint: async (_cloudThread, sha256, file) => {
        heard()
        await released
        copyFileSync(s.cloud.checkpoints.get(sha256) ?? "/missing", file)
      },
      callThread: (cloudThread, channel, args) => s.callThread(cloudThread, channel, args),
      returning: (cloudThread) => s.returns.returning(cloudThread) !== undefined,
      stopped: () => assert.fail("the person changed nothing"),
      worktrees: s.owner,
    })
    const following = follow.follow(s.cloudThread)
    await asked
    // The cloud's next turn, then the way back, while the follow's download of the turn before is still coming.
    writeFileSync(join(s.machine, "a.txt"), "one, the cloud's last turn\n")
    assert.equal((await s.returns.bringBack(s.conversation, move())).kind, "back")
    assert.equal(s.files()[0], "one, the cloud's last turn\n")
    release()
    assert.equal(await following, "not-followed")
    assert.equal(s.files()[0], "one, the cloud's last turn\n", "the finished worktree isn't written over")
  }

  // A forged carry, from an agent with a shell on its machine: a repository this Mac never sent, a launch agent and a
  // removal at paths it never sent. Only what this Mac sent forward is written back, by its own record of that move;
  // the rest is kept apart, never in place. And one file this Mac sent that it can't write back is named with why,
  // while the rest still come and the Thread comes back.
  {
    const s = setup("forged-carry")
    const sent = await s.sentNow()
    const home = join(s.folder, "Users", "ada")
    const sha = (text: string) => createHash("sha256").update(text).digest("hex")
    const entry = (path: string, text: string): MoveOutsideFile => ({ path, kind: "file", sha256: sha(text), bytes: Buffer.byteLength(text), access: "write" })
    // What the forward move sent from outside the worktree: notes.md, and state.json in a folder this Mac can't write now.
    const notes = join(home, "notes.md")
    const locked = join(home, "locked")
    const state = join(locked, "state.json")
    mkdirSync(locked, { recursive: true })
    writeFileSync(notes, "notes, as they left\n")
    writeFileSync(state, "{\"n\":1}\n")
    s.forward((plan) => ({ ...plan, takesCarry: true, carry: { ref: { sha256: "f".repeat(64), bytes: 1 }, manifest: { version: 1, folder: s.checkout, repositories: [{ path: s.checkout, checkpoint: sent }], outside: [entry(notes, "notes, as they left\n"), entry(state, "{\"n\":1}\n")], gone: [], left: [], history: false } } }))
    // Another of the person's repositories, never part of this Thread, with a file Git doesn't track.
    const victim = join(home, "other")
    sh(root, "clone", "--quiet", s.remote, victim)
    writeFileSync(join(victim, "untracked.txt"), "the person's, untracked\n")
    const victimBefore = [sh(victim, "rev-parse", "HEAD"), sh(victim, "status", "--short")]
    const forgedClone = join(s.folder, "forged")
    sh(root, "clone", "--quiet", s.remote, forgedClone)
    writeFileSync(join(forgedClone, "a.txt"), "forged\n")
    const forgedCheckout = await captureMoveCheckpoint(git, forgedClone, mkdtempSync(join(s.folder, "forged-")))
    s.cloud.checkpoints.set(forgedCheckout.checkpoint.sha256, forgedCheckout.file)
    const plist = join(home, "Library", "LaunchAgents", "x.plist")
    const precious = join(home, "precious.txt")
    writeFileSync(precious, "the person's\n")
    const packs = s.cloud.depart
    s.cloud.depart = async () => {
      const departure = await packs()
      const carry = await captureCarry(git, {
        folder: s.checkout,
        repositories: [{ path: s.checkout, checkpoint: departure.checkpoint }, { path: victim, url: REPOSITORY, checkpoint: forgedCheckout.checkpoint }],
        outside: [
          { entry: entry(notes, "notes, from the cloud\n"), bytes: Buffer.from("notes, from the cloud\n") },
          { entry: entry(state, "{\"n\":2}\n"), bytes: Buffer.from("{\"n\":2}\n") },
          { entry: entry(plist, "<plist/>\n"), bytes: Buffer.from("<plist/>\n") },
        ],
        left: [], gone: [precious],
      }, mkdtempSync(join(s.folder, "carry-")))
      s.cloud.checkpoints.set(carry.ref.sha256, carry.file)
      return { ...departure, carry: carry.ref }
    }
    chmodSync(locked, 0o500)
    try {
      const outcome = await s.returns.bringBack(s.conversation, move())
      assert.equal(outcome.kind, "back", "one file it can't write doesn't keep the Thread from coming back")
      const outside = outcome.kind === "back" ? outcome.landed?.outside : undefined
      const kept = join(s.folder, "outside", s.thread)
      assert.deepEqual(outside && { ...outside, failed: outside.failed?.map((each) => each.path) }, { placed: [notes], removed: [], waiting: [], unsent: [plist], failed: [state], kept })
      assert.equal(outside?.failed?.[0]?.why, "permission denied")
      assert.equal(readFileSync(notes, "utf8"), "notes, from the cloud\n", "what this Mac sent comes back to its place")
      assert.equal(readFileSync(state, "utf8"), "{\"n\":1}\n")
      assert.ok(!existsSync(plist), "never written where the machine named it")
      assert.equal(readFileSync(join(kept, plist), "utf8"), "<plist/>\n", "kept apart, for the person to look at")
      assert.equal(readFileSync(precious, "utf8"), "the person's\n", "never removed")
      assert.equal(readFileSync(join(victim, "untracked.txt"), "utf8"), "the person's, untracked\n", "a repository it never sent isn't touched")
      assert.deepEqual([sh(victim, "rev-parse", "HEAD"), sh(victim, "status", "--short")], victimBefore)
      assert.equal(s.files()[0], "one, changed in the cloud\n", "the Thread's own worktree came")
      const told = s.returns.notices(s.conversation)
      assert.match(told[0] ?? "", /never came from this Mac weren't put in place/)
      assert.match(told[0] ?? "", /couldn't be written back on the user's Mac: .*state\.json/)
    } finally {
      chmodSync(locked, 0o700)
    }
  }

  // A project of several repositories that stays in the cloud: every copy kept of this Mac's worktree goes, each
  // repository's, and nothing is left beside the plan.
  {
    const s = setup("several-stay")
    const lib = join(s.folder, "Users", "ada", "worktrees", "lib")
    sh(root, "clone", "--quiet", s.remote, lib)
    s.forward((plan) => ({ ...plan, others: [{ path: lib, url: REPOSITORY }] }))
    s.cloud.depart = async () => { throw new Error("A Thread goes back between turns: Codex is running a turn.") }
    assert.equal((await s.returns.bringBack(s.conversation, move())).kind, "stayed")
    assert.deepEqual(readdirSync(join(s.folder, "returns")).filter((name) => !name.endsWith(".json")), [], "no copy of either repository left")
  }

  // Two agents hear how the same return landed at once: each one's hearing is recorded, and neither hears it again
  // after a restart.
  {
    const s = setup("two-told")
    await s.sentNow()
    const tab = s.tab("claude", "n-2")
    writeFileSync(join(s.checkout, "c.txt"), "the person's own\n")
    assert.equal((await s.returns.bringBack(s.conversation, move())).kind, "back")
    assert.equal(s.returns.notices(s.conversation).length, 1)
    assert.equal(s.returns.notices(tab.conversationId ?? "").length, 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const restarted = s.fresh()
    await restarted.settle()
    assert.deepEqual([restarted.notices(s.conversation), restarted.notices(tab.conversationId ?? "")], [[], []], "neither is told again")
  }

  // The machine can't pack (a turn runs there): cancelled, the Thread runs in the cloud, and the machine keeps it.
  {
    const s = setup("busy")
    s.cloud.depart = async () => { throw new Error("A Thread goes back between turns: Codex is running a turn.") }
    const before = s.files()
    const id = move()
    const outcome = await s.returns.bringBack(s.conversation, id)
    assert.deepEqual(outcome, { kind: "stayed", reason: "A Thread goes back between turns: Codex is running a turn." })
    assert.equal(s.cloud.records.get(id)?.phase, "cancelled")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["elsewhere", 3], "still the cloud's")
    assert.deepEqual(s.files(), before, "nothing here changed")
    assert.deepEqual(s.cloud.calls.find((call) => call.channel === "mako:move-stay")?.args, [{ move: id, device: s.device, reason: "A Thread goes back between turns: Codex is running a turn." }])
  }

  // Records this Mac can't take: the worktree put back exactly, the Thread given back, the machine told to keep it.
  {
    const s = setup("outdated")
    s.setRestored({ kind: "outdated", installed: "0.150.0", upTo: "0.159.3" })
    const before = s.files()
    const id = move()
    const outcome = await s.returns.bringBack(s.conversation, id)
    assert.equal(outcome.kind, "stayed")
    assert.match(outcome.kind === "stayed" ? outcome.reason : "", /codex here is older than the version that wrote this session/)
    assert.deepEqual(outcome.kind === "stayed" ? outcome.outdated : undefined, { harness: "codex", installed: "0.150.0", upTo: "0.159.3", offer: { kind: "update", runtimeId: "codex", label: "codex" } }, "with the update that lets it come")
    assert.deepEqual(s.steps.at(-1), { kind: "stayed", reason: outcome.kind === "stayed" ? outcome.reason : "", outdated: outcome.kind === "stayed" ? outcome.outdated : undefined }, "the window hears the offer too")
    assert.deepEqual(await s.returns.bringBack(s.conversation, id), outcome, "asked again, the same, offer and all")
    assert.equal(s.cloud.records.get(id)?.phase, "given-back")
    assert.deepEqual(s.files(), before, "this Mac's worktree exactly as it was")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["elsewhere", 3])
    assert.ok(s.cloud.calls.some((call) => call.channel === "mako:move-stay"))
  }

  // A store whose schema has no place for the records' columns: refused as outdated, the columns carried for the window and the log.
  {
    const s = setup("lacks")
    s.setRestored({ kind: "outdated", installed: "0.150.0", lacks: ["threads.memory_mode"] })
    const outcome = await s.returns.bringBack(s.conversation, move())
    assert.deepEqual(outcome.kind === "stayed" ? outcome.outdated : undefined, { harness: "codex", installed: "0.150.0", lacks: ["threads.memory_mode"], offer: { kind: "update", runtimeId: "codex", label: "codex" } })
  }

  // A write the store failed: the person reads what failed, not the store's own words, which go to the log.
  {
    const s = setup("store-failed")
    s.failReceive(new Error("Mako couldn't write Devin's session lean-fact into Devin's store here.", { cause: new Error("table tool_call_state has no column named source_node_ids") }))
    const before = s.files()
    const outcome = await s.returns.bringBack(s.conversation, move())
    assert.equal(outcome.kind === "stayed" ? outcome.reason : "", "Mako couldn't write Devin's session lean-fact into Devin's store here.")
    assert.deepEqual(s.files(), before, "this Mac's worktree exactly as it was")
  }

  // The release unheard: unsettled, nothing taken; the next host hears it and finishes.
  {
    const s = setup("unheard")
    const id = move()
    s.cloud.unreachable = 0
    const original = s.cloud.depart
    s.cloud.depart = async () => {
      const departure = await original()
      s.cloud.unreachable = 1
      return departure
    }
    const outcome = await s.returns.bringBack(s.conversation, id)
    assert.equal(outcome.kind, "unsettled")
    assert.equal(outcome.kind === "unsettled" && outcome.waitsOn, "cloud", "it waits on the cloud's answer, and says so")
    assert.match(outcome.kind === "unsettled" ? outcome.reason : "", /^Mako couldn't hear the cloud: the network is down\./)
    assert.equal(s.cloud.records.get(id)?.phase, "returning", "the cloud never heard the release")
    assert.equal(s.state()?.state, "elsewhere", "nothing taken here meanwhile")
    s.cloud.depart = original
    await s.fresh().settle()
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 5], "settled by the next host")
    assert.equal(s.cloud.records.get(id)?.phase, "returned")
  }
  // Conversations begun in the cloud (a `+` tab, a fork) come back with it, and an empty tab's Session too: every
  // Session claimed here, each new conversation's journal made here from its records.
  {
    const s = setup("begun")
    const tab = s.tab("claude", "n-2")
    const forked = s.fork("codex", "n-3", false)
    const empty = s.tab()
    // Adopted there, never started: nothing of it to bring, as the machine says too.
    const unsent = s.tab("claude")
    for (const session of [tab.session, forked.session, empty.session]) {
      const execution = s.threads.execution(session)
      assert.deepEqual([execution?.state, execution?.state === "elsewhere" && execution.owner], ["elsewhere", { kind: "cloud", runtime: cloudRuntimeOf(s.cloudThread) }], "a Session begun in the cloud is the cloud's, as the Thread is")
    }
    const id = move()
    assert.deepEqual(await s.returns.bringBack(s.conversation, id), { kind: "back" })
    const depart = s.cloud.calls.find((call) => call.channel === "mako:move-depart")
    assert.deepEqual(DepartAskSchema.parse(depart?.args[0]).conversations, [s.conversation, tab.conversationId, forked.conversationId], "the machine packs every conversation the Thread has there")
    assert.deepEqual(s.captured, [[tab.conversationId, "/claude/n-2.jsonl"], [forked.conversationId, "/codex/n-3.jsonl"]], "each begun there gets its journal here from its records")
    assert.ok(s.cloud.calls.some((call) => call.channel === "mako:live-snapshot" && call.args[0] === forked.conversationId), "a fork this Mac never heard name its session is asked of the machine, not left behind")
    assert.ok(!s.captured.some(([id]) => id === unsent.conversationId), "one the machine never started brings nothing")
    for (const session of [s.session, tab.session, forked.session, empty.session, unsent.session]) assert.equal(s.threads.execution(session)?.state, "here", "no Session left owned by a machine that ends")
    const group = s.threads.thread(s.thread)
    assert.deepEqual(group?.sessions, [s.session, tab.session, forked.session, empty.session, unsent.session], "in the same Thread, in tab order")
    assert.deepEqual(s.steps.at(-1), { kind: "back", conversations: [s.conversation, tab.conversationId, forked.conversationId] })
  }

  // A tab begun in the cloud just as the Thread set off back: it isn't left on a machine that ends; the Thread is
  // given back, and every Session stays the cloud's, the new one with them.
  {
    const s = setup("race")
    const original = s.cloud.depart
    let late: { session: string; conversationId: string | undefined } | undefined
    s.cloud.depart = async () => {
      late = s.tab("claude", "n-9")
      return original()
    }
    const id = move()
    const outcome = await s.returns.bringBack(s.conversation, id)
    assert.equal(outcome.kind, "stayed")
    assert.match(outcome.kind === "stayed" ? outcome.reason : "", /began in the cloud as the Thread set off back/)
    assert.equal(s.cloud.records.get(id)?.phase, "given-back")
    assert.equal(s.state()?.state, "elsewhere")
    assert.equal(late && s.threads.execution(SessionIdSchema.parse(late.session))?.state, "elsewhere")
    assert.deepEqual(s.captured, [])
  }
  // Asked back again under a new id while one is unsettled: the open one goes on, and no second return begins.
  {
    const s = setup("open")
    const first = move()
    const original = s.cloud.depart
    s.cloud.depart = async () => {
      const departure = await original()
      s.cloud.unreachable = 1
      return departure
    }
    assert.equal((await s.returns.bringBack(s.conversation, first)).kind, "unsettled")
    s.cloud.depart = original
    const second = move()
    assert.deepEqual(await s.returns.bringBack(s.conversation, second), { kind: "back" }, "the open return settles")
    assert.deepEqual([...s.cloud.records.keys()], [first], "the cloud heard one return of the Thread")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 5])
  }

  // This Mac's own work failing after the cloud let go: unsettled, waiting on this Mac, and asked again it comes.
  {
    const s = setup("claim-fails")
    const id = move()
    s.failClaim(1)
    const outcome = await s.returns.bringBack(s.conversation, id)
    assert.deepEqual(outcome.kind === "unsettled" && [outcome.waitsOn, outcome.reason], ["here", "This Mac couldn't finish taking the Thread: database is locked. The cloud let it go, so it runs nowhere until this Mac does. Ask again, or Mako asks when it next starts."], "said as this Mac's, not the cloud's")
    assert.deepEqual(s.steps.at(-1), { kind: "unsettled", reason: outcome.kind === "unsettled" ? outcome.reason : "", waitsOn: "here" })
    assert.deepEqual(await s.returns.bringBack(s.conversation, id), { kind: "back" }, "asked again, it comes")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 5])
  }

  // A worktree that can't be kept as it is (an index with conflicts): cancelled before the cloud let go, the Thread
  // goes on in the cloud, and the machine keeps it.
  {
    const s = setup("unkept")
    const blob = sh(s.checkout, "hash-object", "-w", "a.txt")
    sh(s.checkout, "rm", "--cached", "--quiet", "a.txt")
    execFileSync("git", ["update-index", "--index-info"], { cwd: s.checkout, input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\ta.txt`).join("\n") + "\n" })
    const id = move()
    const outcome = await s.returns.bringBack(s.conversation, id)
    assert.equal(outcome.kind, "stayed")
    assert.match(outcome.kind === "stayed" ? outcome.reason : "", /^This Mac couldn't keep its worktree as it is before taking the cloud's: This checkout has conflicts/)
    assert.equal(s.cloud.records.get(id)?.phase, "cancelled", "never released")
    assert.ok(s.cloud.calls.some((call) => call.channel === "mako:move-stay"), "the machine, which packed, keeps it")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["elsewhere", 3])
    assert.deepEqual(readdirSync(join(s.folder, "returns")).filter((name) => !name.endsWith(".json")), [], "nothing left of the attempt beside its plan")
  }

  // The project the worktree was made from is gone (deleted, or moved away): refused before the cloud is asked
  // anything, the project named for the window, the Thread running in the cloud as it was.
  {
    const s = setup("project-gone", { worktree: true })
    rmSync(s.project, { recursive: true, force: true })
    const before = readFileSync(join(s.checkout, "a.txt"), "utf8")
    const id = move()
    const outcome = await s.returns.bringBack(s.conversation, id)
    assert.deepEqual(outcome, { kind: "stayed", reason: `Its project, ${s.project}, isn't on this Mac anymore: it was moved or deleted. It goes on in the cloud.`, missing: { folder: s.checkout, project: s.project } })
    assert.deepEqual(s.steps, [{ kind: "stayed", reason: outcome.kind === "stayed" ? outcome.reason : "", missing: { folder: s.checkout, project: s.project } }], "no packing: nothing was asked of the cloud")
    assert.deepEqual([s.cloud.records.size, s.cloud.calls.length], [0, 0], "the cloud heard nothing")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["elsewhere", 3])
    assert.equal(readFileSync(join(s.checkout, "a.txt"), "utf8"), before, "nothing here changed")
    assert.ok(!existsSync(join(s.folder, "returns", `${id}.json`)), "no plan was written")
  }

  // The project moved: the person chooses where it is now, the worktree is told, and the Thread comes back into it at
  // the same folder. A folder of another repository is refused, as before, still naming the project.
  {
    const s = setup("project-moved", { worktree: true })
    const moved = join(s.folder, "Users", "ada", "Code", "project")
    mkdirSync(join(s.folder, "Users", "ada", "Code"))
    renameSync(s.project, moved)
    sh(moved, "remote", "set-url", "origin", REPOSITORY)
    const refused = await s.returns.bringBack(s.conversation, move())
    assert.deepEqual(refused.kind === "stayed" && refused.missing, { folder: s.checkout, project: s.project })
    const other = join(s.folder, "other")
    sh(root, "init", "--quiet", other)
    sh(other, "remote", "add", "origin", "https://github.com/octocat/Spoon-Knife")
    const wrong = await s.returns.bringBack(s.conversation, move(), { project: other })
    assert.deepEqual(wrong, { kind: "stayed", reason: `${other} isn't a clone of github.com/octocat/Hello-World, the repository this Thread works in. Choose the folder its project is in now.`, missing: { folder: s.checkout, project: s.project } })
    assert.equal(s.cloud.records.size, 0, "still nothing asked of the cloud")
    assert.deepEqual(await s.returns.bringBack(s.conversation, move(), { project: moved }), { kind: "back" })
    assert.equal(s.files()[0], "one, changed in the cloud\n", "the machine's checkout, in the same folder")
    assert.equal(sh(s.checkout, "symbolic-ref", "--short", "HEAD"), "mako/fix")
    assert.ok(sh(moved, "worktree", "list", "--porcelain").includes(`worktree ${realpathSync(s.checkout)}`), "a worktree of the project where it is now")
    assert.deepEqual(s.threads.worktrees().map((each) => [each.path, each.repoRoot, each.project]), [[s.checkout, moved, moved]], "and the Thread store says so")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 5])
  }

  // The project deleted and cloned again: chosen, the worktree, files and all, joins the new clone.
  {
    const s = setup("project-recloned", { worktree: true })
    rmSync(s.project, { recursive: true, force: true })
    const clone = join(s.folder, "Users", "ada", "again")
    sh(root, "clone", "--quiet", s.remote, clone)
    sh(clone, "remote", "set-url", "origin", REPOSITORY)
    assert.deepEqual(await s.returns.bringBack(s.conversation, move(), { project: clone }), { kind: "back" })
    assert.equal(s.files()[0], "one, changed in the cloud\n")
    assert.match(s.files()[1] ?? "", /b\.txt/)
    assert.ok(!readdirSync(join(s.folder, "Users", "ada", "worktrees")).some((name) => name.includes("mako-reattach")), "nothing left beside it")
  }

  // The worktree's folder is gone and its project is here: made again from the project, on its branch, and the Thread
  // comes back into it.
  {
    const s = setup("folder-gone", { worktree: true })
    rmSync(s.checkout, { recursive: true, force: true })
    assert.deepEqual(await s.returns.bringBack(s.conversation, move()), { kind: "back" })
    assert.equal(s.files()[0], "one, changed in the cloud\n")
    assert.equal(sh(s.checkout, "symbolic-ref", "--short", "HEAD"), "mako/fix")
  }

  // A return an earlier version left released, its worktree never kept, whose project went (the six Threads a proof
  // left): the next host makes it ready or gives it back, and the machine is told to keep it. It never runs nowhere.
  {
    const s = setup("released-unkept", { worktree: true })
    const id = move()
    // What the machine packed then, as it packed it.
    s.cloud.calls.push({ channel: "mako:move-depart", args: [{ move: id, folder: s.checkout, conversations: [s.conversation], device: s.device }] })
    const departure = await s.cloud.depart()
    s.cloud.records.set(id, { phase: "released", move: id, at: clock++, departure })
    mkdirSync(join(s.folder, "returns"), { recursive: true })
    writeFileSync(join(s.folder, "returns", `${id}.json`), JSON.stringify({
      move: id, thread: s.thread, asked: s.conversation, cloudThread: s.cloudThread, folder: s.checkout, forward: s.handoff,
      sessions: [{ session: s.session, conversationId: s.conversation, harness: "codex", nativeId: "n-1", generation: 3 }],
      phase: "released", device: s.device, departing: true, departure, began: clock++, timings: {},
    }))
    rmSync(s.project, { recursive: true, force: true })
    await s.fresh().settle()
    assert.equal(s.cloud.records.get(id)?.phase, "given-back", "given back to the cloud")
    assert.deepEqual(s.cloud.calls.filter((call) => call.channel === "mako:move-stay").map((call) => call.args), [[{ move: id, device: s.device, reason: `Its project, ${s.project}, isn't on this Mac anymore: it was moved or deleted. It goes on in the cloud.` }]], "and its machine runs it again")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["elsewhere", 3], "still the cloud's here")
    assert.deepEqual(await s.returns.bringBack(s.conversation, id), { kind: "stayed", reason: `Its project, ${s.project}, isn't on this Mac anymore: it was moved or deleted. It goes on in the cloud.`, missing: { folder: s.checkout, project: s.project } }, "asked again, it says why, with the project for the window")
    assert.deepEqual(readdirSync(join(s.folder, "returns")).filter((name) => !name.endsWith(".json")), [], "no copies left beside the plan")
  }
  // Archived from this Mac: begun to the archive, packed by its machine toward this Mac, released, then archived; its
  // Thread stays elsewhere here, and nothing of this Mac's changed. Asked again, the same, with nothing asked twice.
  const archivedOf = (s: ReturnType<typeof setup>, op: string): ArchivedThread => {
    const record = s.cloud.records.get(op)
    assert.equal(record?.phase, "archived")
    return { thread: s.cloudThread, move: op, archivedAt: new Date().toISOString(), sessions: [{ session: s.session, thread: s.thread, conversation: s.conversation, harness: "codex", state: "idle", createdAt: new Date().toISOString(), activityAt: new Date().toISOString(), generation: 3, nativeId: "n-1", runsOn: { kind: "cloud", threadId: s.cloudThread }, listedAt: new Date().toISOString() }] }
  }
  {
    const s = setup("archive", { worktree: true })
    const before = s.files()
    const op = move()
    assert.deepEqual(await s.archives().archive(s.cloudThread, op), { kind: "archived", thread: s.cloudThread })
    assert.deepEqual(s.archiveSteps.map((step) => step.kind), ["packing", "ending"])
    const record = s.cloud.records.get(op)
    assert.deepEqual([record?.phase, record?.to, record?.by], ["archived", "archive", s.device], "archived, by this Mac's word")
    assert.equal(record?.phase === "archived" && record.departure?.sessions[0]?.nativeId, "n-1", "what its machine packed is kept with it")
    const depart = s.cloud.calls.find((call) => call.channel === "mako:move-depart")
    assert.deepEqual(depart?.args, [{ move: op, folder: s.checkout, conversations: [s.conversation], device: s.device }])
    assert.deepEqual([s.state()?.state, s.files()], ["elsewhere", before], "this Mac's store and worktree are as they were")
    const calls = s.cloud.calls.length
    assert.deepEqual(await s.archives().archive(s.cloudThread, op), { kind: "archived", thread: s.cloudThread }, "asked again, the same")
    assert.equal(s.cloud.calls.length, calls, "and nothing asked twice")

    // Restored here, the Mac it came from: the second half of a return, from what the archive kept.
    s.steps.length = 0
    const archived = archivedOf(s, op)
    assert.deepEqual(await s.returns.restore(archived), { kind: "back" })
    assert.deepEqual(s.steps.map((step) => step.kind), ["bringing", "back"], "nothing packed again: its machine is gone")
    assert.equal(s.cloud.records.get(op)?.phase, "returned", "the archive is over")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 5], "it runs here, one generation on")
    assert.equal(s.files()[0], "one, changed in the cloud\n", "the checkout the archive kept, over this Mac's")
    assert.ok(!s.cloud.calls.some((call) => call.channel === "mako:move-stay"), "no machine to tell")
    assert.deepEqual(await s.returns.restore(archived), { kind: "back" }, "asked again, the same")
  }

  // A Mac that can't take it back: its worktree is put back exactly, and the Thread stays archived, with no machine to
  // give it to. A Mac that doesn't hold it is told where to restore it, and asks nothing of the cloud.
  {
    const s = setup("archive-kept", { worktree: true })
    const op = move()
    assert.equal((await s.archives().archive(s.cloudThread, op)).kind, "archived")
    const before = s.files()
    s.failReceive(new Error("the records didn't come down"))
    const stayed = await s.returns.restore(archivedOf(s, op))
    assert.deepEqual(stayed, { kind: "stayed", reason: "the records didn't come down. It stays archived." })
    assert.deepEqual([s.files(), s.state()?.state], [before, "elsewhere"], "put back as it was, still the cloud's here")
    assert.equal(s.cloud.records.get(op)?.phase, "archived", "never given back to a machine that's gone")
    assert.ok(!s.cloud.calls.some((call) => call.channel === "mako:move-stay"))
    const elsewhere = setup("archive-elsewhere", { worktree: true })
    const theirs = { ...archivedOf(s, op), sessions: archivedOf(s, op).sessions.map((row) => ({ ...row, conversation: randomUUID() })) }
    const calls = elsewhere.cloud.calls.length
    assert.deepEqual(await elsewhere.returns.restore(theirs), { kind: "stayed", reason: "This Thread came to the cloud from another Mac, or began there: restore it on the Mac it came from." })
    assert.equal(elsewhere.cloud.calls.length, calls)
  }

  // Refused while it works: the gateway's words, nothing begun. A machine that won't pack (a turn just began) cancels it,
  // saying why. One that can't start offers to archive it anyway, which keeps only its records and can't be restored.
  {
    const s = setup("archive-refused", { worktree: true })
    s.cloud.refuseBegin = "This Thread is working. Archive it once its turn ends."
    const working = move()
    assert.deepEqual(await s.archives().archive(s.cloudThread, working), { kind: "refused", thread: s.cloudThread, reason: "This Thread is working. Archive it once its turn ends." })
    assert.equal(s.cloud.records.has(working), false, "nothing begun")
    s.cloud.depart = async () => { throw new Error("A Thread goes back between turns: codex is answering.") }
    const busy = move()
    assert.deepEqual(await s.archives().archive(s.cloudThread, busy), { kind: "refused", thread: s.cloudThread, reason: "This Thread is working (codex is answering). Archive it once its turn ends." }, "in the person's words")
    assert.equal(s.cloud.records.get(busy)?.phase, "cancelled", "cancelled: it goes on as it was")
    s.cloud.depart = async () => { throw new Error("This Thread couldn't start in the cloud. Try again in a moment.") }
    const unstarted = move()
    assert.deepEqual(await s.archives().archive(s.cloudThread, unstarted), { kind: "refused", thread: s.cloudThread, reason: "This Thread couldn't start in the cloud. Try again in a moment.", anyway: true })
    const departs = s.cloud.calls.filter((call) => call.channel === "mako:move-depart").length
    // What this Mac doesn't know the machine runs it can't ask it to pack: never archived without its checkout unasked.
    const unknown = s.there.splice(0)
    const nothing = move()
    assert.deepEqual(await s.archives().archive(s.cloudThread, nothing), { kind: "refused", thread: s.cloudThread, reason: "Mako can't tell yet what this Thread runs in the cloud, so its checkout can't be saved. Try again in a moment.", anyway: true })
    assert.equal(s.cloud.records.get(nothing)?.phase, "cancelled")
    s.there.push(...unknown)
    const anyway = move()
    assert.deepEqual(await s.archives().archive(s.cloudThread, anyway, true), { kind: "archived", thread: s.cloudThread })
    assert.equal(s.cloud.calls.filter((call) => call.channel === "mako:move-depart").length, departs, "archived anyway, its machine isn't asked again")
    const kept = s.cloud.records.get(anyway)
    assert.deepEqual([kept?.phase, kept?.phase === "archived" && kept.departure], ["archived", undefined], "with nothing packed")
  }

  // An archive whose last step wasn't heard stays as its plan says, and the next host finishes it: never left fenced.
  {
    const s = setup("archive-unheard", { worktree: true })
    const op = move()
    const releasing = s.account.releaseReturn
    s.account.releaseReturn = async (...args) => {
      const answered = await releasing(...args)
      s.cloud.unreachable = 1
      return answered
    }
    const first = await s.archives().archive(s.cloudThread, op)
    assert.equal(first.kind, "refused")
    assert.match(first.kind === "refused" ? first.reason : "", /couldn't hear the cloud/)
    assert.equal(s.cloud.records.get(op)?.phase, "released", "released, and not yet archived")
    s.account.releaseReturn = releasing
    await s.archives().settle()
    assert.equal(s.cloud.records.get(op)?.phase, "archived", "the next host archived it")
  }

  console.log("PASS: a Thread comes back from the cloud with one owner throughout: packed, released, laid over this Mac's worktree and claimed here; a machine that can't pack cancels it and keeps the Thread; records that can't be taken put the worktree back and give it back; an unheard release is settled by the next host; conversations begun in the cloud come back with it, and one begun as it set off gives it back rather than be left behind; asked again under a new id, an open return goes on; this Mac's own failure after the release waits on this Mac, and says so; a worktree that can't be kept cancels before the release; a project gone is refused with nothing asked of the cloud, a moved one is chosen and the worktree joins it, a deleted worktree is made again; a return left released and unkept is given back by the next host; an edit made as the checkout came down is merged in, a follow the way back overtook lays nothing, a forged carry writes nothing this Mac never sent, a file that can't be written back is named while the rest come, every repository's copy goes when it stays, and two agents told at once are each recorded; and a Thread archived from here packs and ends in the cloud, is refused while it works, is archived anyway only when asked, is finished by the next host when unheard, and comes back from its archive to the Mac it came from, or stays archived")
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
