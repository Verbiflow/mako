import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import type { ReturnDeparture, ReturnState } from "@mako/protocol/moves"
import type { ReceivedRecords } from "@mako/sessions/record-sync"
import { CloudReturns, type CloudReturnsOptions } from "@mako/host/conversations/cloud-returns"
import { cloudRuntimeOf, type MovePlanSchema } from "@mako/host/conversations/cloud-moves"
import type { ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import { encodeRuntimeValue, type EncodedValue } from "@mako/host/contracts/runtime-value"
import { MoveIdSchema, type MoveId } from "@mako/host/contracts/thread-execution"
import { ThreadStore, type JournalFacts } from "@mako/host/threads/store"
import { captureMoveCheckpoint } from "@mako/host/workspaces/index"
import type { z } from "zod"

/**
 * A Thread of this Mac's coming back from the cloud (`CloudReturns`), against the real Thread store and real
 * checkouts, with the gateway and the machine as stand-ins that keep the gateway's rule (one record per return, which
 * only goes forward). The machine's checkout replaces this Mac's worktree and the Thread runs here again, one
 * generation on; a machine that can't pack cancels it, and the machine is told to keep the Thread; records this Mac
 * can't take put the worktree back exactly and give the Thread back; an answer this Mac can't hear leaves it
 * unsettled until the next host settles it; and asked again, a return answers how it went.
 */
const root = mkdtempSync(join(tmpdir(), "mako-cloud-returns-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
let clock = 1_000

/** The gateway's returns, by its rules, and the machine's departure and stay. */
class Cloud {
  readonly records = new Map<string, ReturnState>()
  readonly calls: Array<{ channel: string; args: readonly unknown[] }> = []
  readonly checkpoints = new Map<string, string>()
  /** The machine's departure: what it packs, or why it can't. */
  depart: () => Promise<ReturnDeparture> = async () => { throw new Error("no departure set") }
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

function setup(name: string) {
  const folder = join(root, name)
  const remote = join(folder, "remote.git")
  const checkout = join(folder, "Users", "ada", "worktrees", "fix")
  const machine = join(folder, "machine", "fix")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(root, "clone", "--quiet", remote, checkout)
  writeFileSync(join(checkout, "a.txt"), "one\n")
  sh(checkout, "add", ".")
  sh(checkout, "commit", "--quiet", "-m", "base")
  sh(checkout, "push", "--quiet", "origin", "main")
  writeFileSync(join(checkout, "a.txt"), "one, as it left this Mac\n")
  // The machine's clone went on: a commit of the agent's, pushed, and a file it left.
  sh(root, "clone", "--quiet", remote, machine)
  writeFileSync(join(machine, "a.txt"), "one, changed in the cloud\n")
  sh(machine, "commit", "--quiet", "-am", "in the cloud")
  sh(machine, "push", "--quiet", "origin", "main")
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
  const plan: z.input<typeof MovePlanSchema> = {
    move: forwardMove, thread: placed.thread, asked: conversation, cloudThread, folder: checkout, repository: { url: "https://github.com/octocat/Hello-World" },
    sessions: [{ session: placed.session, conversationId: conversation, harness: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }],
    phase: "started", handoff, began: 1, timings: {},
  }
  mkdirSync(join(folder, "moves"), { recursive: true })
  writeFileSync(join(folder, "moves", `${forwardMove}.json`), JSON.stringify(plan))

  const cloud = new Cloud()
  const device = randomUUID()
  const steps: ThreadReturnStep[] = []
  const released: string[] = []
  let restored: ReceivedRecords["restored"] = { kind: "restored", path: "/codex/n-1.jsonl", files: 1, rows: 0, ms: 1 }
  cloud.depart = async () => {
    const scratch = mkdtempSync(join(folder, "pack-"))
    const { checkpoint, file } = await captureMoveCheckpoint(git, machine, scratch)
    cloud.checkpoints.set(checkpoint.sha256, file)
    return { checkpoint, sessions: [{ harness: "codex", nativeId: "n-1", holdings: { "codex:n-1.jsonl": 5 } }] }
  }
  const unused = () => Promise.reject(new Error("not in this test"))
  const account: ReturnType<CloudReturnsOptions["account"]> = {
    token: async () => "token", gateway: () => new URL("https://gateway.test"), id: async () => "acct",
    session: () => { throw new Error("no session in this test") },
    deviceId: async () => device,
    createThread: unused, askBases: unused, sendCheckpoint: unused, claimMove: unused, refuseMove: unused, moveAnswer: unused,
    threadRecords: async (threadId) => ({ id: threadId, base: `https://gateway.test/v1/threads/${threadId}/records`, authorization: "Bearer token" }),
    readCheckpoint: async (_threadId, sha256, file) => copyFileSync(cloud.checkpoints.get(sha256) ?? "/missing", file),
    beginReturn: async (_threadId, move) => cloud.step(move, (record) => record ?? { phase: "returning", move, at: clock++ }),
    releaseReturn: async (_threadId, move, departure) => cloud.step(move, (record) => record?.phase === "returning" ? { phase: "released", move, at: clock++, departure } : "past"),
    cancelReturn: async (_threadId, move, reason) => cloud.step(move, (record) => record?.phase === "returning" ? { phase: "cancelled", move, at: clock++, reason } : "past"),
    giveBackReturn: async (_threadId, move, reason) => cloud.step(move, (record) => record?.phase === "released" ? { phase: "given-back", move, at: clock++, reason, departure: record.departure } : "past"),
    finishReturn: async (_threadId, move) => cloud.step(move, (record) => record?.phase === "released" ? { phase: "returned", move, at: clock++, departure: record.departure } : "past"),
    returnState: async (_threadId, move) => cloud.records.get(move),
    wake: () => undefined, stop: () => undefined,
  }
  const make = () => new CloudReturns({
    folder: join(folder, "returns"),
    moves: join(folder, "moves"),
    git,
    account: () => account,
    threads: () => threads,
    claim: (input) => threads.claim(input),
    receiveRecords: async (_link, sessions) => sessions.map((session) => ({ harness: session.harness, nativeId: session.nativeId, pulled: { versions: 1, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1 }, restored })),
    cloud: {
      callThread: async (_threadId, channel, args): Promise<EncodedValue> => {
        cloud.calls.push({ channel, args })
        if (channel === "mako:move-depart") return encodeRuntimeValue(await cloud.depart())
        if (channel === "mako:move-stay") return encodeRuntimeValue({ stayed: true })
        throw new Error(`no ${channel} in this test`)
      },
      release: async (conversationId) => void released.push(conversationId),
    },
    step: (_conversationId, _move, step) => steps.push(step),
  })
  const state = () => threads.execution(placed.session)
  const files = () => [readFileSync(join(checkout, "a.txt"), "utf8"), sh(checkout, "status", "--short")]
  return { returns: make(), fresh: make, cloud, conversation, checkout, steps, released, state, files, device, setRestored: (next: ReceivedRecords["restored"]) => (restored = next) }
}

const move = (): MoveId => MoveIdSchema.parse(randomUUID())

try {
  // The whole way: begun, packed, released, laid over this Mac's worktree, claimed here, done.
  {
    const s = setup("back")
    assert.equal(s.state()?.state, "elsewhere")
    const id = move()
    const outcome = await s.returns.bringBack(s.conversation, id)
    assert.deepEqual(outcome, { kind: "back" })
    assert.deepEqual(s.steps.map((step) => step.kind), ["packing", "bringing", "back"])
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 5], "released (2), the cloud's (3), released there (4), claimed here (5)")
    assert.equal(s.files()[0], "one, changed in the cloud\n", "the machine's checkout, over this Mac's")
    assert.match(s.files()[1] ?? "", /b\.txt/, "with the file the agent left")
    assert.deepEqual(s.released, [s.conversation], "no longer answered by the cloud")
    assert.equal(s.cloud.records.get(id)?.phase, "returned", "the cloud ends the machine")
    const depart = s.cloud.calls.find((call) => call.channel === "mako:move-depart")
    assert.deepEqual(depart?.args, [{ move: id, folder: s.checkout, conversations: [s.conversation], device: s.device }], "released on the machine toward this Mac")
    assert.ok(!s.cloud.calls.some((call) => call.channel === "mako:move-stay"))
    assert.deepEqual(await s.returns.bringBack(s.conversation, id), { kind: "back" }, "asked again, the same")
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
    assert.equal(s.cloud.records.get(id)?.phase, "given-back")
    assert.deepEqual(s.files(), before, "this Mac's worktree exactly as it was")
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["elsewhere", 3])
    assert.ok(s.cloud.calls.some((call) => call.channel === "mako:move-stay"))
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
    assert.equal(s.cloud.records.get(id)?.phase, "returning", "the cloud never heard the release")
    assert.equal(s.state()?.state, "elsewhere", "nothing taken here meanwhile")
    s.cloud.depart = original
    await s.fresh().settle()
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 5], "settled by the next host")
    assert.equal(s.cloud.records.get(id)?.phase, "returned")
  }
  console.log("PASS: a Thread comes back from the cloud with one owner throughout: packed, released, laid over this Mac's worktree and claimed here; a machine that can't pack cancels it and keeps the Thread; records that can't be taken put the worktree back and give it back; an unheard release is settled by the next host")
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
