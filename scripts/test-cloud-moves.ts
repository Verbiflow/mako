import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Git } from "@mako/git"
import type { MoveAnswer, MoveCheckpoint, MoveClaimRequest } from "@mako/protocol/moves"
import { CloudMoves, cloudRuntimeOf, type CloudMovesOptions } from "@mako/host/conversations/cloud-moves"
import { MoveNotQuietError } from "@mako/host/conversations/live-moves"
import type { ThreadMoveStep } from "@mako/host/contracts/cloud-threads"
import { encodeRuntimeValue, type EncodedValue } from "@mako/host/contracts/runtime-value"
import { MoveIdSchema, type MoveId } from "@mako/host/contracts/thread-execution"
import { ThreadStore, type JournalFacts } from "@mako/host/threads/store"

/**
 * A Thread of this Mac's moving to the cloud (`CloudMoves`), against the real Thread store and a real checkout, with
 * the gateway and the machine as stand-ins that keep the gateway's rule (one answer per move, the first): what goes
 * ahead while the Thread still runs here, the release only once nothing works, the machine's arrival with what was
 * sent after the release, the claim, the confirm and each Session resumed natively under its own id; and every way
 * it can fail, each leaving one owner: busy (kept here, nothing released), an arrival that fails (refused, taken
 * back), a claim this Mac never heard (found and gone on with), an answer it can't hear (unsettled, then settled by
 * the next host), and a Thread outside a worktree.
 */
const root = mkdtempSync(join(tmpdir(), "mako-cloud-moves-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
let clock = 1_000

/** The gateway as a move sees it: checkpoints by hash, records sent, and one answer per move, the first. */
class Gateway {
  readonly made: Array<{ threadId: string; folder: string | undefined; harness: string | undefined }> = []
  readonly checkpoints = new Map<string, number>()
  readonly sentRecords: string[][] = []
  readonly answers = new Map<string, MoveAnswer>()
  readonly calls: Array<{ channel: string; args: readonly unknown[] }> = []
  /** The Thread's state here each time the machine was asked whether it's ready. */
  readonly readyWhile: string[] = []
  /** Set to make the machine's arrival fail, or its readiness (a cloud too full to start it), or the next refusals unreachable. */
  arrival: Error | undefined
  ready: Error | undefined
  unreachable = 0
  answered(move: string, answer: MoveAnswer): MoveAnswer {
    const first = this.answers.get(move) ?? answer
    this.answers.set(move, first)
    return first
  }
  reach(): void {
    if (this.unreachable > 0) {
      this.unreachable -= 1
      throw new Error("the network is down")
    }
  }
}

type Setup = { moves: CloudMoves; fresh(): CloudMoves; gateway: Gateway; threads: ThreadStore; steps: ThreadMoveStep[]; conversation: string; session: string; checkout: string; busy: { reasons: string[]; late: string[] }; folder: string; started: string[] }

function setup(name: string, options: { worktree?: boolean } = {}): Setup {
  const folder = join(root, name)
  const remote = join(folder, "remote.git")
  const checkout = join(folder, "Users", "ada", "worktrees", "fix")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(root, "clone", "--quiet", remote, checkout)
  writeFileSync(join(checkout, "a.txt"), "one\n")
  sh(checkout, "add", ".")
  sh(checkout, "commit", "--quiet", "-m", "base")
  sh(checkout, "push", "--quiet", "origin", "main")
  sh(checkout, "checkout", "--quiet", "-b", "mako/fix")
  writeFileSync(join(checkout, "a.txt"), "one, changed by the Thread\n")
  const threads = new ThreadStore(join(folder, "threads.sqlite"), { now: () => clock++, realPath: (path) => path })
  const conversation = randomUUID()
  const facts: JournalFacts = { conversationId: conversation, createdAt: clock++, harness: "codex", bindings: [{ provider: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }] }
  const placed = threads.registerJournal(facts, threads.person())
  const gateway = new Gateway()
  const steps: ThreadMoveStep[] = []
  const reasons: string[] = []
  /** `late`: busy only by the time of the release, after the move asked first and made its cloud Thread. */
  const late: string[] = []
  const busy = { reasons, late }
  const started: string[] = []
  const repository = { url: "https://github.com/octocat/Hello-World" }
  const account: ReturnType<CloudMovesOptions["account"]> = {
    token: async () => "token",
    gateway: () => new URL("https://gateway.test"),
    id: async () => "acct",
    session: () => {
      throw new Error("no session in this test")
    },
    deviceId: async () => randomUUID(),
    createThread: async (threadId, _repository, making) => {
      gateway.made.push({ threadId, folder: making?.folder, harness: making?.harness })
      return { ready: false }
    },
    askBases: async () => undefined,
    sendCheckpoint: async (_threadId, checkpoint: MoveCheckpoint) => {
      const sent = !gateway.checkpoints.has(checkpoint.sha256)
      gateway.checkpoints.set(checkpoint.sha256, checkpoint.bytes)
      return { sent }
    },
    claimMove: async (_threadId, move, request: MoveClaimRequest) => {
      return gateway.answered(move, { kind: "claimed", move, at: clock++, sessions: request.sessions.map((session) => ({ id: session.id, generation: session.generation + 1 })) })
    },
    refuseMove: async (_threadId, move, reason) => {
      gateway.reach()
      return gateway.answered(move, { kind: "refused", move, at: clock++, reason })
    },
    moveAnswer: async (_threadId, move) => {
      return gateway.answers.get(move)
    },
    threadRecords: async (threadId) => ({ id: threadId, base: `https://gateway.test/v1/threads/${threadId}/records`, authorization: "Bearer token" }),
    // The way back's, which this test never takes (`test-cloud-returns.ts` does).
    readCheckpoint: () => Promise.reject(new Error("no return in this test")),
    beginReturn: () => Promise.reject(new Error("no return in this test")),
    releaseReturn: () => Promise.reject(new Error("no return in this test")),
    cancelReturn: () => Promise.reject(new Error("no return in this test")),
    giveBackReturn: () => Promise.reject(new Error("no return in this test")),
    finishReturn: () => Promise.reject(new Error("no return in this test")),
    returnState: () => Promise.reject(new Error("no return in this test")),
    wake: () => undefined,
    stop: () => undefined,
  }
  const make = () => new CloudMoves({
    folder: join(folder, "moves"),
    git,
    account: () => account,
    threads: () => threads,
    moves: {
      settledBlockers: async () => [...busy.reasons],
      begin: (input) => threads.beginMove(input),
      cancel: (input) => threads.cancelMove(input),
      release: async (input) => {
        const late = [...busy.reasons, ...busy.late]
        if (late.length) throw new MoveNotQuietError(late)
        return threads.release(input)
      },
      confirm: (input) => threads.confirm(input),
      reclaim: (input) => threads.reclaim(input),
    },
    snapshot: (id) => (id === conversation ? { session: { harness: "codex", nativeId: "n-1", nativePath: "/codex/n-1.jsonl", cwd: checkout, currentMode: "access:auto" } } : null),
    checkout: () => (options.worktree === false ? undefined : { path: checkout, worktrees: [{}] }),
    repositoryOf: async () => repository,
    sendRecords: async (_link, paths) => {
      gateway.sentRecords.push(paths)
      // Each send holds a newer head, as a Session that went on between the send ahead and the one after the release.
      return paths.map(() => ({ harness: "codex", nativeId: "n-1", versions: 1, held: 0, chunks: 1, bytes: 10, requests: 1, ms: 1, holdings: { "codex:sessions/n-1.jsonl": gateway.sentRecords.length } }))
    },
    cloud: {
      adopt: async (conversation) => void started.push(`adopt ${conversation.conversationId} ${conversation.threadId}`),
      started: (conversationId) => started.push(`started ${conversationId}`),
      callThread: async (_threadId, channel, args): Promise<EncodedValue> => {
        gateway.calls.push({ channel, args })
        if (channel === "mako:move-arrive" && gateway.arrival) throw gateway.arrival
        if (channel === "mako:move-ready") {
          if (gateway.ready) throw gateway.ready
          // Asked while the Thread still runs here: nothing has been released yet.
          gateway.readyWhile.push(threads.execution(threads.journalPlacement(conversation)!.session)?.state ?? "none")
        }
        return encodeRuntimeValue({ ok: true })
      },
    },
    remembered: () => ({ modeId: "access:full", settings: { model: "gpt-5.5" } }),
    step: (_conversationId, _move, step) => steps.push(step),
    newCloudThread: () => `t-${name.padEnd(16, "0").slice(0, 16).replace(/[^0-9a-f]/g, "a")}`,
  })
  return { moves: make(), fresh: make, gateway, threads, steps, conversation, session: placed.session, checkout, busy, folder, started }
}

const move = (): MoveId => MoveIdSchema.parse(randomUUID())
const state = (s: Setup) => s.threads.execution(s.threads.journalPlacement(s.conversation)!.session)
const PlanSchema = z.object({ phase: z.string(), checkpoint: z.object({ sha256: z.string() }).loose().optional() }).loose()
const plan = (s: Setup, id: string) => PlanSchema.parse(JSON.parse(readFileSync(join(s.folder, "moves", `${id}.json`), "utf8")))

try {
  // The whole way: ahead, released, arrived with what was sent after, claimed, confirmed, resumed under its own id.
  {
    const s = setup("moved")
    const id = move()
    const outcome = await s.moves.move(s.conversation, id)
    assert.equal(outcome.kind, "moved", JSON.stringify(outcome))
    assert.deepEqual(s.steps.map((step) => step.kind), ["packing", "handing-over", "resuming", "moved"])
    assert.deepEqual(s.gateway.made.map((made) => made.folder), [s.checkout], "its machine clones at this Mac's own path")
    assert.equal(s.gateway.sentRecords.length, 2, "records sent ahead, and what changed after the release")
    const arrive = s.gateway.calls.find((call) => call.channel === "mako:move-arrive")
    const sent = plan(s, id)
    assert.equal(sent.phase, "started")
    assert.deepEqual(arrive?.args, [{ move: id, folder: s.checkout, checkpoint: plan(s, id).checkpoint, sessions: [{ harness: "codex", nativeId: "n-1", holdings: { "codex:sessions/n-1.jsonl": 2 }, open: { conversationId: s.conversation, modeId: "access:full", tuning: { model: "gpt-5.5" } } }] }], "the machine is told what the last send held, to hold at least that, and to open the session as it ran here before the claim")
    const start = s.gateway.calls.find((call) => call.channel === "mako:live-start")
    assert.deepEqual(start?.args, ["codex", s.checkout, { conversationId: s.conversation, resume: "n-1", modeId: "access:full", tuning: { model: "gpt-5.5" } }], "resumed natively, with the settings it ran with")
    assert.ok(s.gateway.calls.findIndex((call) => call.channel === "mako:move-arrive") < s.gateway.calls.findIndex((call) => call.channel === "mako:live-start"), "nothing starts before the arrival")
    assert.deepEqual(s.gateway.calls.find((call) => call.channel === "mako:move-ready")?.args, [{ folder: s.checkout, harnesses: ["codex"] }])
    assert.deepEqual(s.gateway.readyWhile, ["here"], "its machine was ready before the release")
    assert.deepEqual(s.started, [`adopt ${s.conversation} ${outcome.kind === "moved" ? outcome.cloudThread : ""}`, `started ${s.conversation}`])
    const execution = state(s)
    assert.equal(execution?.state, "elsewhere")
    assert.equal(execution?.state === "elsewhere" && execution.owner.kind === "cloud" && execution.owner.runtime, cloudRuntimeOf(outcome.kind === "moved" ? outcome.cloudThread : ""))
    assert.equal(execution?.generation, 3, "released (2), claimed (3)")
    assert.deepEqual(await s.moves.move(s.conversation, id), outcome, "asked again, the same answer, nothing done twice")
    assert.equal(s.gateway.calls.filter((call) => call.channel === "mako:live-start").length, 1)
  }

  // Busy: refused before anything is made in the cloud, so no machine starts for a move that can't go.
  {
    const s = setup("busy")
    s.busy.reasons.push("Codex is running a turn")
    const outcome = await s.moves.move(s.conversation, move())
    assert.deepEqual(outcome, { kind: "kept-here", reason: "Moves happen between turns: Codex is running a turn." })
    assert.deepEqual(state(s), { state: "here", owner: s.threads.self, generation: 1 }, "nothing begun; the Session is as it was")
    assert.deepEqual([s.gateway.made.length, s.gateway.sentRecords.length, s.gateway.checkpoints.size], [0, 0, 0], "no cloud Thread made, nothing sent")
    assert.equal(s.gateway.answers.size, 0)
  }

  // Busy only by the release (a turn started after the move asked): the release refuses, nothing released, the Thread runs here.
  {
    const s = setup("busy-late")
    s.busy.late.push("Codex is running a turn")
    const id = move()
    const outcome = await s.moves.move(s.conversation, id)
    assert.deepEqual(outcome, { kind: "kept-here", reason: "Moves happen between turns: Codex is running a turn." })
    assert.deepEqual(state(s), { state: "here", owner: s.threads.self, generation: 1 }, "the move was cancelled; the Session is as it was")
    assert.equal(s.gateway.made.length, 1, "its cloud Thread was made ahead")
    assert.equal(s.gateway.answers.get(id)?.kind, "refused", "and refused, so the cloud ends its machine")
    assert.ok(!s.gateway.calls.some((call) => call.channel === "mako:move-arrive"))
  }

  // A harness that can't start on the machine: the arrival fails before the claim, so the cloud refuses and this Mac
  // takes the Thread back, rather than a cloud Thread that can't run.
  {
    const s = setup("no-start")
    s.gateway.arrival = new Error("Cursor couldn't start in the cloud: API key is required.")
    const id = move()
    const outcome = await s.moves.move(s.conversation, id)
    assert.deepEqual(outcome, { kind: "kept-here", reason: "Cursor couldn't start in the cloud: API key is required." })
    assert.equal(s.gateway.answers.get(id)?.kind, "refused", "nothing was claimed")
    assert.equal(state(s)?.state, "here")
    assert.deepEqual(s.started, [], "never adopted as the cloud's")
  }

  // A cloud that can't start the machine (full): the Thread is never released, and the cloud Thread made for it ends.
  {
    const s = setup("full")
    s.gateway.ready = new Error("Mako's cloud is full right now")
    const id = move()
    const outcome = await s.moves.move(s.conversation, id)
    assert.deepEqual(outcome, { kind: "kept-here", reason: "Its cloud machine didn't get ready: Mako's cloud is full right now" }, "the reason names the step")
    assert.deepEqual(state(s), { state: "here", owner: s.threads.self, generation: 1 }, "never released: it ran here throughout")
    assert.equal(s.gateway.answers.get(id)?.kind, "refused", "so the cloud ends the machine it was making")
    assert.ok(!s.gateway.calls.some((call) => call.channel === "mako:move-arrive"))
  }

  // An arrival that fails: refused at the gateway, taken back here.
  {
    const s = setup("refused")
    s.gateway.arrival = new Error("the machine's clone isn't there")
    const id = move()
    const outcome = await s.moves.move(s.conversation, id)
    assert.deepEqual(outcome, { kind: "kept-here", reason: "the machine's clone isn't there" })
    assert.equal(s.gateway.answers.get(id)?.kind, "refused")
    assert.deepEqual([state(s)?.state, state(s)?.generation], ["here", 3], "taken back two owner changes on")
    assert.ok(!s.gateway.calls.some((call) => call.channel === "mako:live-start"))
  }

  // The cloud claimed it but this Mac never heard: its refusal finds the claim, and the move goes on.
  {
    const s = setup("lost-claim")
    const id = move()
    s.gateway.answered(id, { kind: "claimed", move: id, at: 1, sessions: [{ id: s.session, generation: 3 }] })
    const outcome = await s.moves.move(s.conversation, id)
    assert.equal(outcome.kind, "moved")
    assert.equal(state(s)?.state, "elsewhere")
    assert.ok(!s.gateway.calls.some((call) => call.channel === "mako:move-arrive"), "a claimed move isn't sent again")
  }

  // An answer this Mac can't hear: the Thread runs nowhere, and the next host settles it as the cloud answered.
  {
    const s = setup("unsettled")
    s.gateway.arrival = new Error("the gateway didn't answer")
    s.gateway.unreachable = 1
    const id = move()
    const outcome = await s.moves.move(s.conversation, id)
    assert.equal(outcome.kind, "unsettled")
    assert.equal(state(s)?.state, "in-transit", "released and unanswered: it runs nowhere")
    assert.equal(s.steps.at(-1)?.kind, "unsettled")
    s.gateway.arrival = undefined
    await s.moves.settle()
    assert.equal(plan(s, id).phase, "started", "the next try finds no answer, arrives, and is claimed")
    assert.equal(state(s)?.state, "elsewhere")
  }

  // A host that stopped after the release: the next one settles the move from its plan.
  {
    const s = setup("restart")
    const id = move()
    s.gateway.arrival = new Error("the host stopped")
    s.gateway.unreachable = 1
    await s.moves.move(s.conversation, id)
    assert.equal(plan(s, id).phase, "released")
    s.gateway.arrival = undefined
    // A new host: only the plan on disk and the stores it shares with the last one.
    await s.fresh().settle()
    assert.equal(plan(s, id).phase, "started")
    assert.equal(state(s)?.state, "elsewhere")
  }

  // A Thread in the main checkout stays here and says why; so does one this Mac isn't signed in for.
  {
    const s = setup("main-checkout", { worktree: false })
    const outcome = await s.moves.move(s.conversation, move())
    assert.equal(outcome.kind, "kept-here")
    assert.match(outcome.kind === "kept-here" ? outcome.reason : "", /its own worktree/)
    assert.equal(s.gateway.made.length, 0, "nothing made in the cloud")
  }
  console.log("PASS: a Thread moves to the cloud natively with one owner throughout: ahead, released only when quiet, arrived with what was sent after, claimed, resumed under its own id; busy, a failed arrival, a lost claim, an unheard answer and a stopped host each settle with one owner")
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
